# 07 · 运行模型（v0.7）

> 本册把 0.6.0 之后用户提出的七条需求固化成可验收的契约：worktree 决策上移、节点会话顶层化、
> 并发不设上限、按工作区区分、不因实现难度妥协、外部 executor、内建 supervision。
> 事件格式仍归 05，引擎主循环仍归 06；本册只改「谁在什么位置跑、按什么粒度隔离」。

## 1 需求 → 契约

| 编号 | 用户原话要点 | 本册契约 |
|---|---|---|
| R1 | worktree 不该由第一个节点判断，要由开流程的主 agent 判断 | §4：`start()` 之前决定，写进 `run.json.worktree` |
| R2 | 每个节点的主 agent 会话应是独立的顶层会话，能在会话列表看到 | §3：`ctx.agents.create`，不带 `parentAgent`/`parentSession`/`origin` |
| R3 | 工作区不该同时只能有一个 running，不要个数限制 | §5：每 run 一个引擎实例；删上限与排队 |
| R4 | 要按工作区区分（which run 属于哪个工作区） | §4：`run.json.workspace`，列表分组 |
| R5 | 不要因为实现难度在设计上做妥协 | §2：三条红线 |
| R6 | 节点可换成外部 agent（codex 等）执行 | §6：`node.executor` |
| R7 | 主 agent 自己定时唤醒审查，不靠外部插件 | §7：内建 supervision 调度 |

## 2 三条红线（R5）

1. **不许假隔离**：worktree 没建成就不能声称「已隔离」；`strict` 下必须失败，`auto` 下必须把
   `worktree.enabled=false` 与原因落进 `run.json` 并进 live/审计。
2. **不许为让测试变绿改断言**：既有断言（`npm test` 当前 19 个文件 / 491 组）只能因契约变化而改，
   改了要在提交信息里写理由。
3. **做不到就如实标记**：`status` 只能是 `implemented | partial | not-implemented`，附原因与缺什么。
   验收表（§9）里任何一格没证据 = 未完成。

## 3 会话模型（R2）

### 3.1 节点主管会话 = 顶层会话

```
const handle = await agents.create({
  sessionId: nodeSessionId(runId, node.id, attempt),   // 见 3.2
  meta: { cwd, ...(agentPreset ? { agentPreset } : {}) },  // 绝不传 parentSession / origin / delegationDepth
  agentOptions,                                        // node.model 等
})
handle.agent.followup(payload)    // payload 由 inbox.buildFollowupPayload 构造
await handle.agent.whenIdle()
structured = parseAssistantStructured(lastAssistantBySession.get(sessionId))
```

- **禁止**出现 `parentAgent`、`meta.parentSession`、`meta.origin`、`delegationDepth`——任一项都会让宿主
  把它记成子 agent 会话，从顶层会话列表里消失。
- **团队成员的会话不新建**：主管用自己的委派工具起子会话，引擎照旧通过 `parentSession === leadSessionId`
  把它们绑成成员（engine `_bindMember`）。所以 team 模式**不需要**为成员调 `startActivation`。
- `ctx.subagents.startActivation` 只保留给「引擎内部一次性任务」（如果还有），不得再用于节点主管。
- **降级必须可见**：若宿主既没有 `agents.create` 又只有旧 `subagents`，引擎走兼容 spawn 路径时
  必须在 run 日志与 `run.json` 留下痕迹，界面与审计要能看出「这次 run 的节点会话不是顶层会话」。
  静默降级等于骗人。

`run.json.sessionMode` 的确定取值（`src/engine.js` `_resolveSessionMode()`；`src/runstore.js`
`normalizeSessionMode()` 只接受这五个）：

| 值 | 何时写 | 含义 |
|---|---|---|
| `top-level` | 宿主有 `agents.create`（默认） | 节点会话是顶层会话，Web 侧栏可见 |
| `legacy-subagent` | 没有 `agents.create`、只有 `subagents.startActivation` | 兼容 spawn 路径，**不是**顶层会话 |
| `injected` | 测试 / 宿主注入了 `activate` | 会话形态由注入方负责，引擎不做承诺，**不谎称** top-level |
| `stub` | `FLOW_STUDIO_STUB_ENGINE=1` 且测试台双闸门通过 | 桩引擎，不建会话 |
| `unavailable` | 既没有 `agents.create` 也没有 `subagents` | 节点执行时 503 |

### 3.2 会话 id

`nodeSessionId(runId, nodeId, attempt)` 必须：

- 只含 `[A-Za-z0-9._-]`（会话 id 会进持久化路径），节点 id 可能是中文 → 先 slug 化；
- 稳定：同一 `(runId, nodeId)` 的**二次激活必须复用同一个会话 id**（`attempt` 不进 id），
  这样打回重跑是「同一个会话再问一次」，符合 0.6.0 已定的「一个节点一个会话」；
- 唯一：slug 化后冲突时追加 `-` + 8 位哈希。导出一个纯函数 `nodeSessionId`，供测试直接断言。
- 实际形状：`<runId>--<nodeId>` 的 slug，总长 ≤96（`NODE_SESSION_ID_MAX`）；`attempt` 参数
  保留在签名里只为对齐契约，**不参与计算**。

### 3.3 反查与释放

- 引擎维护 `sessionIndex: sessionId → { runId, nodeId, firstAttempt, lastAttempt, createdAt }`，
  供 `flow_reply` / `POST /runs/<id>/messages` 反查，以及 GUI「这个会话属于哪个 run」。
- run 收尾（done/failed/aborted）时 `handle.dispose()`：只关会话句柄，**不删**持久化文件；
  会话仍在 `$DSH_HOME/sessions/**` 里、仍出现在顶层会话列表、仍可被用户点开接管。
  这一点必须在容器测试台里实测（§9 T2），不许只看类型定义就下结论。

> **T2 实测结论（2026-11-06，容器 `dsh-testbed-fs`，证据见 `.tmp/probe/EVIDENCE.md`）**
> - `agents.create` 建出的会话：header 无 `parentSession`/`origin`，`delegationDepth:0` → 顶层，Web 侧栏可见。
> - 子 agent 会话（`startActivation` spawn）：header 带 `parentSession`/`origin:'subagent'`/`delegationDepth:1`；
>   **API 列表 `POST /api/session/list` 会返回它**，只是 Web 客户端按 `origin==='subagent'` 过滤掉。
>   所以「是否顶层」判据是 **session header**，不是 `roots()`（resume 后 agent 在运行时是 root，血缘不变）。
> - `dispose()` 只「从内存 store 移除 + 关持久化句柄」，**不删日志**；会话仍在列表（`agentAvailable:false`）、
>   磁盘文件仍在、进程重启后仍可 `resume`。
> - 会话列表接口是 typert RPC `POST /api/session/list`（`GET /api/sessions` 是 404）。
> - **`blank:true` 的会话在 Web 侧栏不可见**：只 `create` 不跑 turn 的会话 API 有、UI 看不到。
>   节点会话一定会跑 turn，不受影响；但任何「建了不跑」的路径都不能指望它在侧栏可见。

## 4 工作区与 worktree（R1 + R4）

### 4.1 决策点在 start

实际签名：`start(runId, { parent?, workspace?, worktree?, cwd?, agentPreset? })`——决策发生在
`engine.start` 内部（**不是**发起方替引擎决定）；模型工具 `flow_start` 在未显式传 `workspace` 时
取调用方会话的 `header.cwd` 作为候选，HTTP 路由只做形状校验并把 `{ workspace, worktree }` 透传。
`decidedBy` 不是入参，写给 `run.json` 时恒为 `initiator`。结果一次性写进 `run.json`：

```json
"workspace": { "id": "a1b2c3d4e5f6", "path": "/repo", "realpath": "/repo",
               "isGit": true, "gitRoot": "/repo" },
"worktree":  { "enabled": true, "reason": "git-workspace", "decidedBy": "initiator",
               "path": ".../worktrees/a1b2c3d4e5f6/<runId>", "branch": "flow/<runId>",
               "baseCommit": "abc1234", "createdAt": "..." }
```

- `auto`：workspace 是 git 仓库根 → 开；不是 git 仓库 → `enabled:false, reason:'not-a-git-repo'`；
- `on`：不是 git 仓库 → **400 拒绝启动**（不许静默降级）；
- `off`：不建，`reason:'disabled-by-initiator'`。
- **只认「工作区就是 git 仓库根」**：工作区落在某个仓库的子目录里时（`isGit=false && gitRoot!=null`），
  `auto` 不建（`reason:'not-a-git-repo'`，并把 `gitRoot` 记进 `run.json.workspace` 供界面解释），
  `on` 直接 400 说明「请以仓库根为工作区」。**不做**「子目录映射进 worktree」的隐式魔法——
  那会让「已隔离」的声称与实际 cwd 对不上。
- **`auto-without-initiator`**：没有发起方工作区（`options.workspace` / cwd / 会话 `header.cwd`
  都没有），只能回落 `process.cwd()` 时，`auto` **不建** worktree（`reason:'auto-without-initiator'`
  + 一条 warn）。连「这是谁的工作区」都没确定，隔离一份服务进程的 cwd 没有意义；
  显式 `on` 仍照建。
- 建失败：`auto` → `enabled:false, reason:'create-failed: <原因>'` 并把 warning 写进 run 日志；
  `on` → 400。**两种都不许**在 `enabled:true` 的同时其实没建（建完还会 `existsSync` 复核）。
- run 一旦开始，`workspace`/`worktree` 不可再改：带不同 `workspace` 再 start → 400。
  **没有 PATCH 路由**，「不可换」由 `engine.start` 的 `_resolveWorkspaceBinding()` 校验。
- 节点会话 / 外部 executor 的 `cwd`：worktree 开着就用 `worktree.path`，否则 `workspace.path`。

### 4.2 布局

- 根：`$DSH_HOME/flow-studio/worktrees/<workspaceId>/<runId>`
- 分支：`flow/<runId>`（已存在则 `flow/<runId>-2`…，并把最终名写进 run.json）
- base：`workspace` 的 `HEAD`（记录 baseCommit）
- 创建：`git -C <workspace> worktree add -B <branch> <path> <baseCommit>`
- **不自动删**：run 收尾保留（用户可能要看产物）。`removeWorktree()` 提供受校验的删除入口：
  先检查路径落在 `<root>/<workspaceId>/` 下，再 `git -C <workspace> worktree remove [--force] <path>`；
  目录不存在返回 `not-found`，不假装删过。**当前没有 HTTP 路由或模型工具暴露它**，只能由模块调用方
  （脚本 / 运维动作）显式触发。

### 4.3 列表分组（R4）

`run.summary` 带 `workspaceId` / `workspacePath` / `worktreeEnabled`；`GET /runs` 支持
`?workspaceId=` 过滤；客户端按工作区分组显示。并发粒度按 run，不按工作区。

## 5 并发不设上限（R3）

v0.7 之前：模块级 `START_LOCK` + 引擎实例上的一堆 per-run 字段 ⇒ 全局只能一个 run。

改法（**不抽字段，改实例粒度**）：

- `class Engine`（导出名；实现类为 `FlowEngine`）继续持有所有 per-run 字段，但**一个实例只服务
  一个 run**；
- 新增 `src/runtime.js`：`createRuntime({...})` → 进程级注册表
  - `runs: Map<runId, Engine>`；`start(runId, options)` 先查表，已有 → 409「同一 run 已在跑」，
    没有 → `new Engine(...)` 并 `start()`；
  - `stop/wait/sweep/get/list` 按 runId 路由到对应实例；
  - 跨 run 的共享状态（`sessionIndex`、supervision、startedBy、日志器）放这里；
  - 实例收尾（`onSettled`）后**立刻**从表里摘掉并释放事件订阅；不轮询、不保留 5 分钟。
    run.json 仍可读，`flow_watch` 走磁盘读终态。
- 删除 `START_LOCK`、`FLOW_STUDIO_MAX_CONCURRENT_RUNS`、任何 per-workspace 上限与排队（`queued`）。
- 唯一 409 = **同一个 runId 已在跑**；不同 runId（同工作区或跨工作区）一律并行。
- 跨进程仍由 `runstore.claimLease` 保证同一 run 只有一个写者。

## 6 外部 executor（R6）

- `node.executor`: `'dsh'`（默认）| `'codex'` | `'custom'`；`custom` 必填 `node.executorCommand`。
- 仅 `mode:'single'` 允许外部 executor（team 需要引擎观察成员会话，外部进程做不到）。
  保存是宽松的（见 §7.1），这条规则在**启动**时由 `validateFlowForRun` 400 拦下。
- codex 的真实 argv（顺序固定；`-s` 默认 `workspace-write`）：
  ```
  codex exec --json --output-schema <schema.json> -C <cwd> --skip-git-repo-check \
    -s workspace-write [-m model] <prompt>
  ```
  `node.executorCommand` 对 codex 只作**可执行文件路径覆盖**（默认 `codex`），不是完整模板。
  逐行读 stdout JSONL，映射成节点日志事件 + 用量（有 usage 才记）+ 最终 `agent_message` 文本；
  文本按 `parseAssistantStructured` 解析，解析不出按既有 `StructuredOutputError` 处理。
- custom：`executorCommand` 是 `sh -c` 模板，用 `{prompt}` / `{schema}` / `{cwd}` 占位
  （shell 单引号转义）；三个都没写时把 prompt 追加为最后一个参数。stdout 同样逐行读。
- schema 固定写在 `<runsRoot>/<runId>/executors/<attemptId>.schema.json`（目录 0700、文件 0600），
  内容就是 `ENGINE_OUTPUT_SCHEMA`；失败语义 / 事件映射见 06 §17。
- 超时/重试/abort 沿用现有节点语义（`MAX_NODE_RETRIES`、`signal`）。
- 测试一律用桩命令（`node -e '...'` 或 `sh -c`），不依赖真 codex。

## 7 内建 supervision（R7）

- 归属：`createRuntime()` 起**一个** `SupervisionScheduler` / 一个 `setInterval`（默认 15s；
  `supervisionIntervalMs` 优先，其次 `intervalMs`；定时器 `.unref()`），扫描在跑 run。
- 每次 tick 对每个 run：`auditWorkflow(...)` → `nextDueAt` 规则
  `healthy 180s / 异常 60s / pending 30s / 终态 null（停）`；未知 verdict 按异常侧 60s。
- 到点 → `agents.get(wakerSessionId)`；没有就 `agents.resume({resumeSessionId})`；然后
  `followup(提示词)` 唤醒发起会话，让它调 `flow_watch` 自查。
- 幂等：`run.json.supervision` 记 `{ enabled, wakerSessionId, lastWokeAt, nextDueAt, wakes,
  failures, reason }`，同一 `nextDueAt` 只唤醒一次；到点后立刻推进 `nextDueAt`（成功失败都推进）；
  重启后从 run.json 恢复。
- 降级：连续 3 次唤醒失败 → `enabled:false, reason:'wake-failed: ...'`。写**宿主 warn 日志**
  与 `run.json.supervision`，不新增 runlog 事件、不刷屏；成功一次清零 `failures`。
- 入口：`flow_supervise {runId, enabled}` 模型工具 + `POST /runs/<id>/supervision`；客户端只读展示。
- **默认开启**：由 `flow_start`（模型工具，`exec.agent` 存在）启动的 run 自动登记调度，
  `wakerSessionId` = 发起会话；HTTP 起的 run 默认不开（没人可唤醒）。返回提示语为
  「内置调度已开启，无需再挂闹钟」；0.5.0 的 `alarmPrompt` / `nextCheckSeconds` 字段保留但不再推荐。
  登记失败只 warn，不拖垮 `flow_start`：返回 `supervision.enabled=false` 并给出手动回退提示。
- **恢复只登记有 waker 的 run**：`enabled===true && wakerSessionId` 非空才 register；
  缺 waker 只记 info 跳过（不算失败，也不写 `enabled:false`）。

### 7.1 宽严分界（保存 vs 启动）

- **保存宽松**：`POST /flows`、`PUT /flows/<id>` 对能解析成对象的请求回 200 +
  `{ok, flow, validation}`，即使 `validation.errors` 非空也照存。仍会 400 的只有形状/协议错误
  （body 不是 JSON 对象、PUT 缺 body、`version` 不是正整数）。原因：画布是 600ms 防抖自动保存，
  用户会拖出还没填 task 的空节点、也会新建空流程；把校验错误变成 400 等于让编辑没法进行。
- **启动严格**：`validateFlowForRun` 在 `POST /runs/<id>/start` 与 `flow_start` 上拦死。
  executor 的两条规则（`custom` 缺命令、外部 executor 配 `team`）在这里同样生效，非法流程启动 → 400。
- 判断标准：**能不能写下来 ≠ 能不能跑**。合法 JSON 对象都允许写下来，跑之前必须过门禁。

## 8 模块契约（实现按这些签名落地）

### `src/worktree.js`（纯 + 注入 runner，不 import dsh）

```js
export function workspaceIdFor(realpath)                       // → 12 位 hex
export async function resolveWorkspace({ cwd, path, run })      // → { id, path, realpath, isGit, gitRoot }
export function decideWorktree({ workspace, policy })           // → { enabled, reason } | throws { code:'WORKTREE_UNAVAILABLE' }
export async function createWorktree({ workspace, runId, root, branchPrefix, baseRef, run })  // → record
export async function inspectWorktree({ workspace, record, run })  // → { exists, head, dirty }
export async function removeWorktree({ workspace, record, run, force, root })  // 校验路径前缀，否则拒绝
```

`run(argv, { cwd, timeoutMs })` 默认 `execFile` 包装，测试注入。

### `src/executor.js`（纯 + 注入 spawn）

```js
export const EXECUTORS = Object.freeze(['dsh', 'codex', 'custom'])
export function normalizeExecutor(node)                          // dsh → { kind:'dsh' }；codex/custom 另带 command/args/model
                                                                 // 非法组合 throws { code:'EXECUTOR_INVALID' }
export function buildCodexArgs({ cwd, schemaPath, model, sandbox, prompt })
export function parseCodexLine(line)                             // → { kind:'log'|'usage'|'final'|'ignore', ... }
export async function runExternalExecutor({ spec, prompt, cwd, timeoutMs, signal, spawn, onEvent })
                                                                 // → { ok, text, structured, exitCode, usage, events, reason?, tail? }
```

### `src/supervise.js`（纯逻辑 + 注入时钟/唤醒）

```js
export const SUPERVISION_INTERVALS = Object.freeze({ healthy: 180, anomaly: 60, pending: 30 })
export function planWake({ run, now, verdict, lastWokeAt })       // → { shouldWake, nextDueAt, reason }
export class SupervisionScheduler {                              // 注入 now / evaluate / wake / load / save / log
  constructor(opts); start(); stop(); async tick(); register(runId, { wakerSessionId }); unregister(runId); status(runId)
}
```

### `src/runtime.js`（新，进程级）

```js
export function createRuntime({ ctx, runsRoot, flowsRoot, logger, now, ...engineDeps })
// → { start(runId, opts), stop(runId), wait(runId), sweep(), get(runId), list(), engines(),
//     sessionIndex, supervision, enableSupervision(runId, opts), supervisionReady, dispose() }
```

## 9 验收

| # | 判据 | 证据 |
|---|---|---|
| T1 | 引擎不再出现 `startActivation` 建节点会话；节点会话无 `parentSession` | 单测 + 容器里读 session 头 |
| T2 | 节点会话出现在顶层会话列表；run 收尾 dispose 后仍在列表、可 resume | 容器实测（不是类型推断） |
| T3 | 同工作区两个 run 并发跑通；不同工作区并发跑通；同 runId 二次 start → 409 | 单测 + 容器 |
| T4 | `worktree.enabled=true` 时 run 目录里真的有那个 worktree；`on` + 非 git → 400 | 单测 + 容器（真 git 仓库） |
| T5 | codex/custom executor 用桩命令跑通，产出结构化判定 | 单测 |
| T6 | supervision 到点只唤醒一次、重启恢复、失败降级 | 单测 + 容器 |
| T7 | `npm test` 全绿、`node scripts/build.mjs` 通过、client 体积在限内 | 命令输出 |

## 10 实现状态

2026-11-06 按代码逐项核对；`npm test` 19 个文件 / 491 组全绿。状态口径按 §2 第 3 条：
`implemented` = 代码、测试或实测证据都在；本表没有 `partial / not-implemented`。

| 编号 | 状态 | 落地位置（文件 · 函数 / 入口） | 复核证据 |
|---|---|---|---|
| R1 | `implemented` | `src/engine.js` `start()` → `_resolveWorkspaceBinding()` / `_resolveWorktreeRecord()`；`src/worktree.js` `resolveWorkspace()` / `decideWorktree()` / `createWorktree()` | `test/worktree.test.mjs`（20 组 / 92 条）；`test/engine.test.mjs`「engine v0.7 · 工作区与 worktree（R1+R4）」5 组 |
| R2 | `implemented` | `src/engine.js` `_resolveSessionMode()` / `_defaultActivate()` / `_createNodeSession()` / `nodeSessionId()` / `_disposeRunSessions()`；`src/runstore.js` `normalizeSessionMode()` | `test/engine.test.mjs`「engine v0.7 · 会话降级可见（sessionMode）」2 组；容器 T2 实测（本册 §3.3） |
| R3 | `implemented` | `src/runtime.js` `createRuntime()` / `start()` / `settleInstance()`；`src/engine.js` `start()` 的实例级 `active` 占位 | `test/runtime.test.mjs`（16 组 / 152 条，含「两个不同 runId 并发」「同 runId 409」） |
| R4 | `implemented` | `src/engine.js` `_resolveWorkspaceBinding()` / `_patchRunBinding()`；`src/index.js` `handleRuns()` 的 `?workspaceId=` 过滤与 `runWorkspaceFields()`；`src/client/flowlist.js` `groupRunsByWorkspace()` | `test/engine.test.mjs` R1+R4 组；`test/host.test.mjs` workspace 参数组；`test/render.test.mjs` 分组渲染组 |
| R5 | `implemented` | `src/engine.js` `_resolveWorktreeRecord()`（建后 `existsSync` 复核、`auto` 失败落 `enabled:false`）、`_resolveSessionMode()`（降级可见）；`src/worktree.js` `removeWorktree()` 路径前缀校验 | `test/engine.test.mjs`「worktree:'on' + 非 git → 400」「auto 不擅自建」；`test/worktree.test.mjs` 路径越界拒绝 |
| R6 | `implemented` | `src/executor.js` `normalizeExecutor()` / `buildCodexArgs()` / `parseCodexLine()` / `runExternalExecutor()`；`src/engine.js` `_executorSpecOf()` / `_writeExecutorSchema()` / `_runExternalNode()`；`src/model.js` `EXECUTOR` / `validateFlow()` | `test/executor.test.mjs`（13 组 / 81 条）；`test/engine.test.mjs`「engine v0.7 · 外部 executor（R6）」5 组 |
| R7 | `implemented` | `src/supervise.js` `planWake()` / `SupervisionScheduler`；`src/runtime.js` `createRuntime()` 的 `wakeRun()` / `evaluateRun()` / `enableSupervision()` / `supervisionReady`；`src/tools.js` `flow_supervise`；`src/index.js` `POST/GET /runs/<id>/supervision` | `test/supervise.test.mjs`（27 组 / 194 条）；`test/runtime.test.mjs`（16 组 / 152 条）；`test/tools.test.mjs`（35 组 / 336 条）；`test/host.test.mjs` supervision 路由组 |

**已知边界**（如实列出）：`removeWorktree()` 目前没有 HTTP / 模型工具入口；`injected` 会话形态由注入方
负责，引擎不承诺其顶层性；跨进程 supervision 只按落盘 `lastWokeAt` 避重，不提供分布式锁。
