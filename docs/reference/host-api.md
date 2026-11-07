# Host 接口

插件在 Host 侧注册单条 `prefix` 路由 `/api/flow-studio`，客户端同源 fetch 调用；模型工具是同一套能力在会话里的入口。

## 鉴权

**与 `/api` 同口径**：插件路由虽然绕过了 webserver 的 `/api` 通用鉴权（最长前缀优先），但每个 handler 入口都会调宿主 `ctx.get('connection')?.requestRejection(req)`，把判定权交回宿主（401 / 403 与 `/api` 一致；拿不到该服务时 **fail-closed 503**，绝不放行）。

另有可选第二道闸 `FLOW_STUDIO_TOKEN`（≥16 字符，只认 `Authorization: Bearer`；`?token=` 仅导出接口允许）。`/health` 在未鉴权时只说「认证档位」，不报内部路径。

## 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/flows` | 流程摘要列表（目录为空时自动种一份出厂模板） |
| POST | `/flows` | 新建；**200 + `{ok, flow, validation}`**，`validation.errors` 非空也照存；只有请求体不是 JSON 对象才 400 |
| GET | `/flows/<id>` | 读整份（含 `version`）+ 校验结果 |
| PUT | `/flows/<id>` | 整份覆盖保存；`validation.errors` 只报告不拦保存（仍会 400 的只有：body 不是 JSON 对象 / 缺 body / `version` 不是正整数）；版本冲突回 409（`FLOW_VERSION_CONFLICT`），成功回传新 `version` |
| DELETE | `/flows/<id>` | 删除 |
| GET | `/skills` | 当前 profile 已注册的 skill 目录（`ctx.skills.list()`） |
| GET | `/health` | schema 版本、skills 服务是否在位、`auth` 档位（`connection` = 只走宿主登录门；`token` = 另配了 `FLOW_STUDIO_TOKEN`）、`engine`（`real` / `stub`）、`version`；未鉴权时不返回目录 |
| GET/POST | `/runs` | run 列表（`limit`；`workspaceId` 过滤）/ 新建 run（`pending`，不自动开跑）。列表行与详情都带 `workspaceId` / `workspacePath` / `worktreeEnabled` / `workspace` / `worktree` / `sessionMode` / `supervision` / `nodeStatus` |
| POST | `/runs/<runId>/start` | 真正开跑（`pending`→`running` 原子转换；同一 runId 已在跑 → 409；流程非法 → 400） |
| POST | `/runs/<runId>/stop` | 停止（协作式取消，写 `run/end aborted`） |
| GET/DELETE | `/runs/<runId>` | run 详情（节点与 attempt 索引 + `progress.nodes` + 工作区 / worktree / sessionMode / supervision / nodeStatus）；`?light=1` 走轻量分支（run 元信息 + `live` + `nodeStatus` + 工作区/worktree 摘要，**不读取也不解析事件**，客户端运行中 2s 轮询用它）/ 删除整个 run（租约持有中 → 409） |
| GET/POST | `/runs/<runId>/supervision` | 读 `run.json.supervision` + 调度器状态 / 开或关内建 supervision（`{enabled, wakerSessionId?}`；对已收尾 run 开启 → 400） |
| GET/POST | `/runs/<runId>/events` | 事件流（`nodeId`、`attemptId`、`kind`、`since`、`order=desc`、`limit`）/ 追加事件（≤200 条/批，整批校验；只收观测类事件） |
| GET/POST | `/worktrees` | 孤儿 worktree 清单（`listWorktrees` + 已记录的删除指针）/ `{action:'prune', keepRunIds?}` 回收（`pruneWorktrees`，连 `flow/<runId>` 分支一起清） |
| DELETE | `/runs/<runId>/worktree` | 删该 run 的 worktree（显式传 `root`、`force` 恒 true；返回 `{ok, removed, reason, branchRemoved}`） |
| GET | `/runs/<runId>/summary` | 指标聚合（token / skill 覆盖率 / findings / 打回 / 进度 / 质量结论）+ `nodeStatus` |
| GET | `/runs/<runId>/export` | 导出 markdown（唯一允许 `?token=` 的接口） |

## 收件箱与回复通道

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/runs/<runId>/messages` | 往流程收件箱发一条外部消息（与 `flow_send_message` 同一条内部逻辑）；`{from?, text, nodeId?, reply?}` |
| GET | `/runs/<runId>/messages` | 看收件箱（分页） |
| POST | `/runs/<runId>/inbox` | 动态改这个 run 的默认回复目标 |

投递语义与回复通道的三种 `kind` 见 [收件箱与节点会话](../guide/inbox-and-sessions.md)。

## 模型工具

会话里可用的 `flow_*` 工具，参数与返回字段的完整定义在 `src/tools.js`；这里只列入口。

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `flow_list` | 列流程模板 | `limit`（默认 20，最大 100） |
| `flow_start` | 在**当前会话**启动 run，并默认开启内建 supervision | `flowId` / `flowName`、`task` / `name`、`workspace`、`worktree`、`runTimeoutMs` / `nodeTimeoutMs` |
| `flow_watch` | 只读审查整个工作流 | `runId` 或 `runIds`（≤20，二选一） |
| `flow_stop` | 停止 run | `runId` |
| `flow_supervise` | 手动开关 run 级 supervision | `runId`、`enabled` |
| `flow_send_message` | 往收件箱发消息 | `runId?`、`nodeId?`、`text`、`reply?` |
| `flow_reply` | 节点内 agent 回复来源 | `text`、`inReplyTo?` |
| `flow_worktrees` | 列 / 回收 worktree | `action`、`keepRunIds?` |

用法闭环见 [在会话里开流程](../guide/session-driven.md)。

## 权限与安全开关

| 环境变量 | 作用 |
|---|---|
| `FLOW_STUDIO_TOKEN` | **全权**令牌（≥16 字符，`Authorization: Bearer`） |
| `FLOW_STUDIO_READ_TOKEN` | **只读**令牌：只允许 `GET`，任何写请求 → 403（`code:"READ_ONLY_TOKEN"`） |
| `FLOW_STUDIO_ALLOW_CUSTOM_EXECUTOR` | 默认关。关闭时保存 / 启动含 `executor:'custom'` 的流程 → 400（`code:"CUSTOM_EXECUTOR_DISABLED"`）——custom 会在宿主 `sh -c` 执行任意命令，等价宿主 RCE，**只能由运维在主机上打开** |
| `FLOW_STUDIO_WORKSPACE_ROOTS` | 可选，冒号分隔的绝对路径；配置后 `workspace` 必须落在其中之一（realpath 比较，防 symlink 绕过），否则 400 |
| `FLOW_STUDIO_RUN_TIMEOUT_MS` / `FLOW_STUDIO_NODE_TIMEOUT_MS` | 墙钟上限默认 2h / 单节点 20min；`start` 的显式参数优先于它 |
| `FLOW_STUDIO_NODE_ALARM_MS` | 节点自审闹钟间隔（默认 600000 = 10 分钟） |
| `FLOW_STUDIO_NODE_RETRIES` | 节点重试次数（0–5，默认 1） |
| `FLOW_STUDIO_WAKER_HOURLY_LIMIT` / `FLOW_STUDIO_WAKER_MIN_INTERVAL_MS` | 同一发起会话的 run 级唤醒预算（默认 30 次/小时、最小间隔 120s） |
| `FLOW_STUDIO_FLOW_MACHINE` | `=0` 回退 0.8.x 的旧主循环（逃生门，留一个发布周期） |
| `FLOW_STUDIO_STUB_ENGINE` | 桩引擎（容器测试台用；不调模型，只验证编排 / 事件 / 指标 / 打回 / 落盘） |

`/health` 会报 `authMode`（`full` / `read`）、`readOnly`、`customExecutor`、`workspaceAllowlist`（只报条数）、`limits`（默认超时）等能力位，让调用方知道自己的令牌能干什么。

## 错误与状态码

| 码 | 含义 |
|---|---|
| 400 | 请求体 / 参数 / 流程校验失败（启动门禁 `validateFlowForRun` 与引擎同口径：成环、多出边、打回指向非阶段节点等） |
| 401 / 403 | 宿主鉴权拒绝；只读令牌写操作 403 `READ_ONLY_TOKEN` |
| 404 | 流程 / run 不存在 |
| 409 | 版本冲突 `FLOW_VERSION_CONFLICT`；同一 runId 已在跑；删除租约持有中的 run |
| 413 | 请求体超限（可读文案，不断连） |
| 503 | 拿不到宿主 `connection` 服务时 fail-closed |

## 延伸阅读

- 事件与聚合：[运行日志](run-log.md)（契约正文在 [design/05](../design/05-run-log.md)）
- 流程 / run 字段：[数据模型](data-model.md)
- 运行模型与 supervision 设计：[design/07](../design/07-runtime-0.7.md)
