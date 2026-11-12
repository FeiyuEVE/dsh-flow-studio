# Host 接口

插件在 Host 侧注册单条 `prefix` 路由 `/api/flow-studio`，客户端同源 fetch 调用；模型工具是同一套能力在会话里的入口。

**0.14.0 起只有一个运行域：BPMN 定义域与实例域。** 旧 `/flows`、`/runs`、`/worktrees`、`/worktrees/prune` 已删除；已通过鉴权的请求访问它们返回 **404**（不做兼容跳转）。旧 `/flows` / `/runs` 的字段说明只作历史资料，当前路由、参数与字段一律以 [实例域接口](instance-api.md) 为准。

## 鉴权

**与 `/api` 同口径**：插件路由虽然绕过了 webserver 的 `/api` 通用鉴权（最长前缀优先），但每个 handler 入口都会调宿主 `ctx.get('connection')?.requestRejection(req)`，把判定权交回宿主（401 / 403 与 `/api` 一致；拿不到该服务时 **fail-closed 503**，绝不放行）。

另有可选第二道闸，只认 `Authorization: Bearer`：

| 环境变量 | 作用 |
|---|---|
| `FLOW_STUDIO_TOKEN` | **全权**令牌（≥16 字符） |
| `FLOW_STUDIO_READ_TOKEN` | **只读**令牌：只允许 `GET`；任何写请求 → 403（`code:"READ_ONLY_TOKEN"`） |

两档都配置时先匹配全权；配置了但不足 16 字符会在 `apply()` 启动时直接拒绝并告警（fail-closed，不退回同源）。

跨站请求（`Origin` 与 `Host` 不一致）一律 403。

## 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 版本、鉴权档位、`bpmn` 能力计数（`definitions` / `instances` / `active` / 引擎版本）、已注册 adapter id、workspace 白名单条数、skills 服务是否在位；未鉴权时不返回内部路径 |
| GET | `/skills` | 当前 profile 已注册的 skill 目录（`ctx.skills.list()`） |
| * | `/definitions[/…]` | 定义列表 / 读取版本 / 保存新版本；**定义不可删除**（没有删除路由，`DELETE /definitions/<id>` 返回 405）；完整路由见 [实例域接口](instance-api.md) |
| * | `/instances[/…]` | 实例启动 / 列表 / 详情 / 事件 / 取消 / 人工任务 / 收件箱 / 指标 / 证据；完整路由见 [实例域接口](instance-api.md) |
| * | `/instance-worktrees[/…]` | 实例 worktree 的 inspect / list / remove / branch / prune |
| * | `/metrics` | 跨实例指标汇总 |

`/health` 的稳定字段示例（只列契约，细值随运行变化）：

```jsonc
{
  "ok": true,
  "auth": "connection",       // connection | token
  "authMode": "connection",   // connection | full | read
  "readOnly": false,
  "capabilities": {
    "write": true,
    "workspaceAllowlist": { "configured": false, "count": 0 }
  },
  "version": "0.14.0",
  "schemaVersion": 1,
  "bpmn": { "enabled": true, "engine": "26.0.6", "definitions": 0, "instances": 0, "active": 0 },
  "adapters": ["codex", "dsh"],
  "skills": true
}
```

旧字段 `engine`（real / stub）、`runsDir`、`customExecutor`、`limits` 已随旧运行域删除；调用方不要再读它们。

## 模型工具

会话里可用的 `flow_*` 工具共 **13 个**，全部属于实例域；旧 `flow_list` / `flow_start` / `flow_watch` / `flow_stop` / `flow_restart` / `flow_supervise` / `flow_send_message` / `flow_reply` / `flow_node_reject` / `flow_compile` / `flow_decompile` / `flow_worktrees` 已删除。工具定义与参数在 `src/instance-tools.js`，逐项说明在 [实例域接口 · 模型工具](instance-api.md#模型工具)。

| 工具 | 作用 |
|---|---|
| `flow_definition_list` / `flow_definition_get` | 列 / 读定义版本 |
| `flow_instance_run` | 启动实例 |
| `flow_instance_list` / `flow_instance_get` / `flow_instance_events` | 列 / 读实例与增量事件 |
| `flow_instance_cancel` | 取消实例（`ACTIVE` → `CANCELED`） |
| `flow_instance_complete_task` | 完成人工待办 |
| `flow_instance_suspend` / `flow_instance_resume` | 挂起 / 恢复实例（quiesce 式；恢复不主动推进） |
| `flow_instance_worktrees` | 实例 worktree 的 list / inspect / remove / branch / prune |
| `flow_instance_send_message` / `flow_instance_reply` | 实例收件箱发消息 / 回复来源 |

agent 节点会话里另有 `flow_finish_node`：由 AgentAdapter（dsh 会话级工具 / codex 与 ACP 的 MCP server）提供，节点必须调用它提交结论与证据才能完结。它不是全局注册的 13 个工具之一，见 [finish 工具](../design/11-node-finish-tool.md)；ACP 的通道与证据分层见 [ACP 适配器](../design/14-acp-adapter.md)。

## 环境变量

| 环境变量 | 作用 |
|---|---|
| `FLOW_STUDIO_TOKEN` / `FLOW_STUDIO_READ_TOKEN` | 见「鉴权」 |
| `FLOW_STUDIO_WORKSPACE_ROOTS` | 可选，冒号分隔的绝对路径；配置后实例工作区必须落在其中之一（realpath 比较，防 symlink 绕过） |
| `FLOW_STUDIO_BPMN_MAX_ACTIVE` | 进程内活跃实例上限（默认 100） |
| `FLOW_STUDIO_BPMN_ACTIVITY_TIMEOUT_MS` | 单个活动的超时（毫秒；不设 = 只受实例 / signal 控制） |
| `FLOW_STUDIO_AGENT_GLOBAL` / `FLOW_STUDIO_AGENT_PER_WORKSPACE` | agent 执行并发上限（全局 / 每工作区） |
| `FLOW_STUDIO_AGENT_QUEUE_MAX` / `FLOW_STUDIO_AGENT_QUEUE_TIMEOUT_MS` | 并发满时的有限排队长度 / 等待上限 |
| `FLOW_STUDIO_FINISH_SOCKET` / `FLOW_STUDIO_FINISH_TOKEN` | codex MCP 完结通道的每执行私有 IPC 凭据（适配器内部设置，不需要手工配置） |
| `FLOW_STUDIO_ACP_CONFIG` | ACP 适配器的唯一配置入口，JSON 对象；字段见下文 [ACP 适配器配置](#acp-适配器配置) |

### ACP 适配器配置

`FLOW_STUDIO_ACP_CONFIG` 只在节点显式使用 `adapter:"acp"` 时由 ACP 适配器读取；不读实例字段，不拼接 shell 字符串，不自动 `npx` 下载。省略或空串使用默认配置；直接调用解析函数时显式 `null` 也按省略处理。

```jsonc
{
  "command": "codex-acp",
  "args": [],
  "env": {},
  "mode": "workspace-write",
  "permissionPolicy": "deny"
}
```

| 字段 | 类型 | 默认 | 非法值 |
|---|---|---|---|
| `command` | 非空字符串（可执行名或路径），不含控制字符 | `"codex-acp"` | 空串、非字符串、含 `U+0000`–`U+001F` / `U+007F` → `ACP_CONFIG_INVALID` |
| `args` | 字符串数组；每项不得含 NUL | `[]` | 非数组、非字符串项、含 NUL → `ACP_CONFIG_INVALID` |
| `env` | 字符串值对象；变量名匹配 `^[A-Za-z_][A-Za-z0-9_]*$`；值不得含 NUL | `{}` | 非对象、变量名非法、`__proto__` / `constructor` / `prototype`、大小写不敏感前缀 `FLOW_STUDIO_FINISH_`、非字符串值 → `ACP_CONFIG_INVALID` |
| `mode` | 非空字符串，≤128 字符，不含控制字符 | `"workspace-write"` | 空串、非字符串、超长、含控制字符 → `ACP_CONFIG_INVALID`；传到 agent 后值不在 `availableModes` → `ACP_MODE_UNAVAILABLE` |
| `permissionPolicy` | `"deny"` 或 `"allow"` | `"deny"` | 其它值（含大小写变体、布尔、`null`）→ `ACP_CONFIG_INVALID` |

- 顶层必须是 JSON 对象；非法 JSON、非字符串原始值或未知键一律 `ACP_CONFIG_INVALID`。错误结果只带结构化 `message`，不回显原始 JSON 或配置值。
- 子进程环境 = 宿主白名单（`PATH` / `HOME` / `LANG` / 代理变量 / `LC_*` / `CLAUDE_*` / `ANTHROPIC_*` 等）+ 本表 `env`；`FLOW_STUDIO_FINISH_*` 由适配器按执行生成，管理员不能覆盖。
- `mode` 与 `permissionPolicy` 的运行时语义、probe 与完结行为见 [ACP 适配器](../design/14-acp-adapter.md)；错误码全集见 [实例域接口 · ACP 适配器错误码](instance-api.md#acp-适配器错误码)。

## 错误与状态码

| 码 | 含义 |
|---|---|
| 400 | 请求体 / 参数 / 定义结构不合法（`BPMN_PARSE_*` / `INSTANCE_SHAPE_INVALID` 等，响应带可读 `error` 与稳定 `code`） |
| 401 / 403 | 宿主鉴权拒绝；只读令牌写操作 403 `READ_ONLY_TOKEN`；跨站 403 |
| 404 | 定义 / 实例 / 事件 / worktree 不存在；旧运行域路由 |
| 409 | 乐观锁冲突、实例终态不可写、worktree 计划过期 / 实例仍活跃 |
| 503 | 拿不到宿主 `connection` 服务时 fail-closed；BPMN 运行时已释放 |
| 413 | 请求体超限（可读文案，不断连） |

## 延伸阅读

- 定义 / 实例路由与字段：[实例域接口](instance-api.md)
- 事件契约：[design/10](../design/10-bpmn-instance-api.md)
- 指标：[design/12](../design/12-instance-metrics.md)
- 证据：[design/13](../design/13-instance-evidence.md)
- 落盘布局：[数据模型](data-model.md)
