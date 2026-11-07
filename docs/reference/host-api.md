# Host 接口

插件在 Host 侧注册单条 `prefix` 路由 `/api/flow-studio`，客户端同源 fetch 调用；模型工具是同一套能力在会话里的入口。

## 鉴权

**与 `/api` 同口径**：插件路由虽然绕过了 webserver 的 `/api` 通用鉴权（最长前缀优先），但每个 handler 入口都会调宿主 `ctx.get('connection')?.requestRejection(req)`，把判定权交回宿主（401 / 403 与 `/api` 一致；拿不到该服务时 **fail-closed 503**，绝不放行）。

另有可选第二道闸 `FLOW_STUDIO_TOKEN`（≥16 字符，只认 `Authorization: Bearer`；`?token=` 仅导出接口允许）。`/health` 在未鉴权时只说「认证档位」，不报内部路径。

## 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/flows` | 流程摘要列表（目录为空时自动种一份出厂模板） |
| POST | `/flows` | 新建；**200 + `{ok, flow, validation}`**，`validation.errors` 非空也照存；保存类 400 只有请求体不是 JSON 对象，以及主机未开 `FLOW_STUDIO_ALLOW_CUSTOM_EXECUTOR` 却含 `executor:'custom'`（`CUSTOM_EXECUTOR_DISABLED`） |
| GET | `/flows/<id>` | 读整份（含 `version`）+ 校验结果 |
| PUT | `/flows/<id>` | 整份覆盖保存；`validation.errors` 只报告不拦保存（仍会 400 的只有：body 不是 JSON 对象 / 缺 body / `version` 不是正整数 / `nodes`、`edges` 键缺失或不是数组（`FLOW_BODY_INCOMPLETE`）/ 主机未开 `FLOW_STUDIO_ALLOW_CUSTOM_EXECUTOR` 却含 `executor:'custom'`（`CUSTOM_EXECUTOR_DISABLED`））；`nodes: []` / `edges: []` 仍然 200（0.7 宽松口径，空图是合法的整份替换）；版本冲突回 409（`FLOW_VERSION_CONFLICT`），成功回传新 `version` |
| DELETE | `/flows/<id>` | 删除 |
| GET | `/skills` | 当前 profile 已注册的 skill 目录（`ctx.skills.list()`） |
| GET | `/health` | schema 版本、skills 服务是否在位、`auth` 档位（`connection` = 只走宿主登录门；`token` = 另配了 `FLOW_STUDIO_TOKEN`）、`engine`（`real` / `stub`）、`version`；未鉴权时不返回目录 |
| GET/POST | `/runs` | run 列表（`limit`；`workspaceId` 过滤）/ 新建 run（`pending`，不自动开跑）。列表行与详情都带 `workspaceId` / `workspacePath` / `worktreeEnabled` / `workspace` / `worktree` / `sessionMode` / `supervision` / `nodeStatus` |
| POST | `/runs/<runId>/start` | 真正开跑（`pending`→`running` 原子转换；同一 runId 已在跑 → 409；流程非法 → 400） |
| POST | `/runs/<runId>/stop` | 停止（协作式取消，写 `run/end aborted`） |
| POST | `/runs/<runId>/restart` | **失败 / 中止后重启**：基于旧 run 的完成进度**新建一个 run**（202），继承旧节点会话、跳过已完成节点、从旧失败节点继续；旧 run 终态与事件不改写。可选 body `{note}`（≤500 字）。只接受 `failed` / `aborted`；`pending` / `running` → 400（先等收尾或 stop），`done` → 400（不需要重启）；当前流程结构不合法 / 续跑起点已不存在 → 400 可读原因 |
| GET/DELETE | `/runs/<runId>` | run 详情（节点与 attempt 索引 + `progress.nodes` + 工作区 / worktree / sessionMode / supervision / nodeStatus）；`?light=1` 走轻量分支（run 元信息 + `live` + `nodeStatus` + 工作区/worktree 摘要，**不读取也不解析事件**，客户端运行中 2s 轮询用它）/ 删除整个 run（租约持有中 → 409） |
| GET/POST | `/runs/<runId>/supervision` | 读 `run.json.supervision` + 调度器状态 / 开或关内建 supervision（`{enabled, wakerSessionId?}`；对已收尾 run 开启 → 400） |
| GET/POST | `/runs/<runId>/events` | 事件流（`nodeId`、`attemptId`、`kind`、`since`、`order=desc`、`limit`）/ 追加事件（≤200 条/批，整批校验；只收观测类事件） |
| GET/POST | `/worktrees` | 孤儿 worktree 清单（`listWorktrees` + 已记录的删除指针）/ `{action:'prune', keepRunIds?}` 回收（`pruneWorktrees`，连 `flow/<runId>` 分支一起清） |
| DELETE | `/runs/<runId>/worktree` | 删该 run 的 worktree（显式传 `root`、`force` 恒 true；返回 `{ok, removed, reason, branchRemoved}`） |
| GET | `/runs/<runId>/summary` | 指标聚合（token / skill 覆盖率 / findings / 打回 / 进度 / 质量结论）+ `nodeStatus` |
| GET | `/runs/<runId>/export` | 导出 markdown（唯一允许 `?token=` 的接口） |

保存的宽松口径（0.7 拍板）：`validation.errors` 非空照存；`nodes: []` / `edges: []`（用户删光节点）也是合法整份替换，仍然 200。`PUT` 只是额外要求这两个键**存在且是数组**（`FLOW_BODY_INCOMPLETE`），不对节点 / 连线内容做内容级校验——那留给启动 run 的 `validateFlowForRun`。

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
| `flow_restart` | 把 failed / aborted run 重启为**新 run**并在原会话续跑 | `runId`（旧 run）、`note?`（≤500 字）；返回 `newRunId` + `restart{fromRunId, attempt, startNodeId, skippedNodeIds, inheritedNodeIds, ...}` |
| `flow_supervise` | 手动开关 run 级 supervision | `runId`、`enabled` |
| `flow_send_message` | 往收件箱发消息 | `runId?`、`nodeId?`、`text`、`reply?` |
| `flow_reply` | 节点内 agent 回复来源 | `text`、`inReplyTo?` |
| `flow_worktrees` | 列 / 回收 worktree | `action`、`keepRunIds?` |

用法闭环见 [在会话里开流程](../guide/session-driven.md)。

## 节点会话的模型路由与 agent preset（0.9.2 P0）

`ctx.agents.create()` 建节点主管会话时，引擎**永远显式**传两样东西；任何一样解析
不出来都会在创建之前给可诊断的 503，而不是建一个注定首轮失败的会话：

1. **模型路由必须同源成对**：`agentOptions = {provider, model}`，绝不跨来源拼。
   - 节点显式 provider + model **整对**优先（流程模型里 `provider` 会落在
     `node.extras.provider`，引擎两处都认）；节点只配一半 → `503`
     （`MODEL_ROUTE_CONFLICT`；另一来源也没有整对时 `MODEL_ROUTE_UNAVAILABLE`），
     **不再**用宿主默认补齐缺的一项；
   - 节点完全没配才回退：`sessions.json` 记录的会话对（resume）> 宿主
     `agentDefaultModel.currentSelection()` 的整对；宿主只返回一半 →
     `MODEL_ROUTE_PARTIAL_HOST`；
   - 节点自定义 `model` 时**不**移植宿主的 `reasoningEffort`（不同模型档位不可移植），
     只有节点自己给了才带；
   - 拿不到 `agentDefaultModel` 且节点配置不成对（含空配置）→
     `503`，文案含「宿主未提供 agentDefaultModel，且节点未配置 provider/model」。
     0.2.2-rc.1 的首轮 `preStep` 会抛 `agent "…" has no provider/model`，且
     `agent/request` waterfall 已不允许再改路由，所以这里必须提前拦住。
   - **resume 也走同一函数**：`agents.resume({ resumeSessionId, agentOptions, setup })`
     的 `agentOptions` 来自节点显式对 > `sessions.json` 记录的会话对 > 宿主默认；
     旧会话没有记录对时回退宿主。规则与错误码见 `docs/plan/0.10-方案.md` §4.1。

2. **agent preset 必须显式，而且必须挂组合**：`meta.agentPreset` **只写 session
   header**（鉴权 / 投影用），**不会挂载 preset 组合**。组合只在
   `agents.create()` / `agents.resume()` 的 `setup` 回调里挂载
   （`dsh-agent-loop/lib/index.js:1567`），Web 的正确形状是
   `create({ sessionId, agentOptions, meta:{cwd, agentPreset}, setup: composition.setup })`
   （`dsh-api-session-controller/lib/index.js:424-439`）。0.2.2 宿主对没有组合的程序化
   会话给的是几乎没有工具的裸组合——开发节点改不了代码、测试节点跑不了测试、
   团队主管没有 `subagent` 工具。

   **引擎的 composition 解析顺序**：
   1. `ctx.get('sessionController').composeAgent(presetId)` —— 与 Web 同一条路径
      （挂 preset + 模型切换提示），首选；create 与 resume **两处**都传
      `setup: composition.setup`；
   2. 只有 `ctx.get('agentPresets')` → `presets.resolve(id)`，并在 setup 里
      `presets.mount(agentCtx, resolvedId)`。这里不装 `installModelSelection`：
      它只是「会话中途换模型时追加一条提示」的 `agent/pre-step` 监听，不影响工具面 /
      路由；插件不为它引入 `@deepseek-ai/dsh-agent` 依赖（宿主能力一律 `ctx.get`）；
   3. 两个服务都没有 → 不传 `setup`，但留一条可诊断 warn（节点会掉回裸工具面）。

解析顺序（第一个非空生效）：

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | 节点 `agentPreset` | 画布上按节点覆盖（空 = 继承） |
| 2 | 本次 start 的 `agentPreset` | `engine.start(runId, {agentPreset})` 显式覆盖 |
| 3 | 引擎配置 `agentPreset` | 插件 / runtime 构造参数 |
| 4 | 流程级 `agentPreset` | 流程 JSON 的默认值（空 = 继承） |
| 5 | **`standard`** | 引擎兜底；本机 web profile 里带完整工具面的那套 |
| 5' | 宿主默认 preset | 当来源是兜底 `standard`、而当前 profile **没有** `standard` 时，改用 `composeAgent(undefined)` / `presets.resolve(undefined)` 取宿主默认；`agentPresetSource` 记为 **`default-fallback`**，事件 / run.json 报实际 id |

- 节点 / 流程的 `agentPreset` 只做安全 id 校验（小写字母 / 数字 / `-` / `_`，≤64）；
  preset 是否真实存在由宿主 registry 在创建会话时判断——插件可以注册
  `digital-human` / `specialist` 这类自定义 id，模型层不维护会过期的白名单。
- 生效值与来源写进 `node/start.data.agentPreset` / `agentPresetSource`
  （`node` / `start` / `engine` / `flow` / `default` / `default-fallback`）与
  `run.json.agentPreset`（`{value, source}`，run 级默认），供 UI 显示。
- **降级原则**：来源是 `default`（引擎自己兜底）时，`standard` 不存在可以降级到宿主
  默认；来源是 `node` / `flow` / `start` / `engine`（用户显式配置）时**不降级**，
  直接 `400`，文案点明节点、preset id 与「去节点检查器 / 流程设置改，或改空用默认」。
- 会话中途换模型时的提示（`installModelSelection`）只在路径 1 由
  `sessionController.composeAgent` 自带；路径 2 刻意省略，见上。

## 节点会话的预热轮（首轮精简规避）

新建节点会话会先收到一条**不调工具的预热消息**，正式任务从第二轮开始。原因：首轮精简插件（`@feiyueve/dsh-minimal-first-turn`）把**新根会话的第一轮**工具面裁到最小对（`bash` + `str_replace_editor`），下一轮才恢复 preset 的完整清单——节点会话是程序化顶层会话，同样被裁，于是「主管 + 子 agent」节点在第一轮看不到 `subagent`，派不出成员；开发 / 测试节点也拿不到 `glob` / `grep` / `todo_write`。

- 只对**本次新建**的会话预热；打回重跑 / `restart` 复用的冷会话不再预热（它们早已走过第一轮）。
- 预热失败（宿主报错 / abort）**不阻断节点**：warn 之后照常发正式任务，最坏退化成 0.9.1 的行为。
- 关闭：环境变量 `FLOW_STUDIO_WARMUP_FIRST_TURN=0`，或构造参数 `warmUpFirstTurn: false`。
- 判据（排障用）：`node/start` 之后、正式 attempt 之前，会话里多出一条以「【引擎预热 · 本会话第 1 轮】」开头的 user 消息；引擎日志有「发送预热轮 / 预热轮完成」。

## 团队节点的收口（等成员 + 补要结论）

团队节点（`mode:'team'`）的主管用 `subagent`（spawn 异步）把活派出去后，成员不会阻塞主管的回合——真机实测主管常常在自己的回合里回一句「两名成员仍在执行，继续等待回执」，于是**本轮没有 JSON 结论**，而成员几秒后才把产物写完：节点被判结构不合格、白跑一轮。

现在的收口行为（只在「本轮没有正式结论」且节点是 `team` 时触发，**不放宽判定**）：

1. **等**：轮询已观测到的成员会话是否还 `working`（有界，`FLOW_STUDIO_TEAM_WAIT_MS` 默认 120s，2s 一次）。成员会话已从宿主注册表消失视为结束。
2. **要**：发一条带同一 attempt/nonce 契约的补充指令（`【引擎补充指令 · 结论必须在本轮给出】`），要求主管用规定格式给出结论；补要失败或仍无结论时按原语义报结构不合格。

排障：引擎日志有「等成员收口 Nms」「本轮没有正式结论（团队节点），补发一次收口指令」。关闭等待（`FLOW_STUDIO_TEAM_WAIT_MS=0`）只会跳过第 1 步，补要结论照旧。

### 补要之后的最后一道兜底：状态块 + 结论合并（v0.9.5）

真机事故（run `r-mw67vqpf-okns` / 节点 `n_dev`）：主管补要结论后交的是**一个对象同时含状态与结论**
（`{"state":"done","progress":100,"blockers":[],"verdict":"pass",...,"artifacts":[...]}`），
而严格判定「有 `state` 键就是自审状态块」把整块丢掉 → 补要过一次仍然 `StructuredOutputError`，
节点白跑一轮还重试一次。

现在的规则（**只在补要结论之后**才生效，正常回合严格语义不变）：

- 放宽只认**完成态 + 带结论证据**的合并块：`state === 'done'` 且至少带一个证据字段
  （`artifacts` / `findings` / `acceptance` / `tests` / `checks`）；
- `state !== 'done'`（如 `working`）的状态块里夹 `verdict` 仍然**不算**结论，避免「没干完先报 pass」；
- 合并块里的 `attempt` / `nonce` 同样要匹配；同一条回复里若有**纯正式结论**，仍然优先纯结论；
- 命中时引擎日志留一条 warn：`补要结论后拿到的是「状态块 + 结论」合并块，按结论收口`。

## 阶段节点的打回工具（`flow_node_reject`）

阶段节点主管在自己的 attempt 进行中可以直接调用模型工具 `flow_node_reject`，
语义**等价于结构化结论 `verdict=reject`**：

- 参数：`reason`（必填，≤2000 字）、`findings`（可选数组）、`rejectTarget`（可选，
  必须是该节点某条 reject 边的目标）；
- 工具只把 `{reason, findings, rejectTarget}` 登记到引擎的「本轮待生效打回」槽位；
  本轮 `whenIdle` 收口时与既有结构化结论合流（工具打回优先于模型文本里的 `pass`），
  之后**完全复用**既有通道：`node/end{status:'rejected'}` → `selectRejectTarget()` →
  `reject/trigger` → 目标节点 attempt+1 重跑。没有第二套状态、不新增事件 kind。

**结构门控（硬规则）**：

- 只有当前流程里存在 `edges.some(e => e.from === node.id && e.kind === 'reject')`
  的**阶段节点**才注册；没有出向 reject 边 → 不注册（会话工具清单里根本不出现）；
- 开始 / 结束节点不注册；
- 每次 attempt / 复用冷会话都会按**当前流程结构**重算：结构加边 → 补挂，删边 →
  用注册返回的 disposer 撤掉；run 结束 / attempt 结束时统一 dispose。

**没有出向 reject 边但模型仍判 reject（旁路）**：保留 run 失败，**不降级为 pass**；
`node/end{status:'rejected'}` 的 `extra.rejectBypass='no-edge'` 标出旁路，失败原因提示
「补一条从该节点出发的打回边后，用『修复后重启』在原会话续跑；或把结论改为 pass」。
状态机默认路径与 `FLOW_STUDIO_FLOW_MACHINE=0` 的 legacy 路径同一口径。

## 失败后重启（`restart`）

`POST /runs/<runId>/restart` 与模型工具 `flow_restart` 共用同一条实现
（`runtime.restart`），语义是**新建一个续跑 run**，而不是把旧 run 改回 running：

- 只接受 `failed` / `aborted`；非终态与 `done` 都给 400 可读原因；
- **服务端互斥**：同一旧 run 的 restart 在途时并发请求直接 400；已经存在
  `restart.fromRunId === 旧 run` 的续跑 run 时也 400（避免两个新 run 同时 resume 同一批
  会话）。续跑失败请重启那个续跑 run，不要重复重启旧 run；
- 用旧 run 的事件流推导续跑起点（`run/end` 的 failedNodeId → 最后一条
  `node/end failed` → 中止时未收口的 `node/start`）与**已完成节点**；
- 新 run 继承旧 `sessions.json` 里当前流程仍存在的阶段节点会话（同一 node 复用
  原 sessionId；冷会话走 `agents.resume`）；
- 已完成节点不重跑，它们的 summary / 产物路径作为上游上下文注入；
- 新 run 从旧失败节点继续（续跑 run 走旧主循环，支持显式起点）；
- 旧 run 保持终态、事件一条不改；
- 新 run 的 `run.json.restart` 记录
  `{fromRunId, attempt, oldStatus, oldReason, startNodeId, skippedNodeIds, inheritedNodeIds, note?, at}`，
  `run/start.data.restart` 同步落日志（`attempt` = 第几次续跑）。

**为什么用新 run 而不是同一 run 的 continuation**：旧 run 的 `run/end`、租约、
supervision、事件序号都是已经发生过的事实；原地续跑要么改写历史终态（破坏审计），
要么让 `status` 在 `failed` → `running` → `done` 之间来回跳（前端 / 指标会看到两次
收尾）。新 run 有独立事件流，`restart.fromRunId` + `restart.attempt` 足以还原世系。

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
| `FLOW_STUDIO_WARMUP_FIRST_TURN` | `=0` 关闭新建节点会话的**预热轮**（默认开）。见[节点会话的预热轮](#节点会话的预热轮首轮精简规避) |
| `FLOW_STUDIO_TEAM_WAIT_MS` | 团队节点「等成员收口」的上限（默认 120000 = 2 分钟，2s 轮询一次） |
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
