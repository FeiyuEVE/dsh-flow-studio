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

export const NODE_ALARM_DEFAULT_MS = 120_000                     // v0.8 §11
export function parseNodeStatus(text)                            // → 状态对象 | null（纯函数，不抛错）
export class NodeSupervisionScheduler {                          // 注入 now / wake / log / intervalMs / nodeAlarmMs / maxFailures
  constructor(opts); start(); stop(); async tick()
  register({ runId, nodeId, sessionId, attempt, intervalMs })     // 同 sessionId = 刷新
  unregister(sessionId); unregisterNode(runId, nodeId); unregisterRun(runId); status(sessionId); list()
}
```

### `src/runtime.js`（新，进程级）

```js
export function createRuntime({ ctx, runsRoot, flowsRoot, logger, now, ...engineDeps })
// → { start(runId, opts), stop(runId), wait(runId), sweep(), get(runId), list(), engines(),
//     sessionIndex, supervision, nodeSupervision, wake(entry),
//     enableSupervision(runId, opts), supervisionReady, dispose() }
// 另导出纯函数 nodeSelfCheckPrompt(entry)（模块级 export，不在 runtime 对象上）。
```

## 9 验收

| # | 判据 | 证据 |
|---|---|---|
| T1 | 引擎不再出现 `startActivation` 建节点会话；节点会话无 `parentSession` | 单测 + 容器里读 session 头 |
| T2 | 节点会话出现在顶层会话列表；run 收尾 dispose 后仍在列表、可 resume | 容器实测（不是类型推断） |
| T3 | 同工作区两个 run 并发跑通；不同工作区并发跑通；同 runId 二次 start → 409 | 单测 + 容器 |
| T4 | `worktree.enabled=true` 时 run 目录里真的有那个 worktree；`on` + 非 git → 400 | 单测 + 容器（真 git 仓库） |
| T5 | codex/custom executor 跑通并产出结构化判定 | 单测（桩命令）+ **真 codex 实测**（06 册 §17.9：直连 19.7s、整条 run 25.5s、`usage` 记上、节点 passed） |
| T6 | supervision 到点只唤醒一次、重启恢复、失败降级 | 单测 + 容器 |
| T7 | `npm test` 全绿、`node scripts/build.mjs` 通过、client 体积在限内 | 命令输出 |
| T8 | 节点闹钟：建会话即登记、attempt 结束 / run 收尾注销、`node/status` 上报与三处可见、`done+verdict` 提前完成、连续 3 次失败停摆、外部 executor 不挂闹钟 | 单测：`test/supervise.test.mjs` 8.1–8.6、`test/engine.test.mjs` ①–⑨、`test/runtime.test.mjs` 节点闹钟组、`test/tools.test.mjs` `flow_watch` 组、`test/runlog.test.mjs` 2 组、`test/host.test.mjs` `nodeStatus` 组、`test/render.test.mjs` 节点状态区块组（**尚无容器实测**） |

## 10 实现状态

2026-11-06 按代码逐项核对；`npm test` 19 个文件 / 540 组全绿。状态口径按 §2 第 3 条：
`implemented` = 代码、测试或实测证据都在；本表没有 `partial / not-implemented`。

| 编号 | 状态 | 落地位置（文件 · 函数 / 入口） | 复核证据 |
|---|---|---|---|
| R1 | `implemented` | `src/engine.js` `start()` → `_resolveWorkspaceBinding()` / `_resolveWorktreeRecord()`；`src/worktree.js` `resolveWorkspace()` / `decideWorktree()` / `createWorktree()` | `test/worktree.test.mjs`（20 组 / 92 条）；`test/engine.test.mjs`「engine v0.7 · 工作区与 worktree（R1+R4）」5 组 |
| R2 | `implemented` | `src/engine.js` `_resolveSessionMode()` / `_defaultActivate()` / `_createNodeSession()` / `nodeSessionId()` / `_disposeRunSessions()`；`src/runstore.js` `normalizeSessionMode()` | `test/engine.test.mjs`「engine v0.7 · 会话降级可见（sessionMode）」2 组；容器 T2 实测（本册 §3.3） |
| R3 | `implemented` | `src/runtime.js` `createRuntime()` / `start()` / `settleInstance()`；`src/engine.js` `start()` 的实例级 `active` 占位 | `test/runtime.test.mjs`（22 组 / 178 条，含「两个不同 runId 并发」「同 runId 409」） |
| R4 | `implemented` | `src/engine.js` `_resolveWorkspaceBinding()` / `_patchRunBinding()`；`src/index.js` `handleRuns()` 的 `?workspaceId=` 过滤与 `runWorkspaceFields()`；`src/client/flowlist.js` `groupRunsByWorkspace()` | `test/engine.test.mjs` R1+R4 组；`test/host.test.mjs` workspace 参数组；`test/render.test.mjs` 分组渲染组 |
| R5 | `implemented` | `src/engine.js` `_resolveWorktreeRecord()`（建后 `existsSync` 复核、`auto` 失败落 `enabled:false`）、`_resolveSessionMode()`（降级可见）；`src/worktree.js` `removeWorktree()` 路径前缀校验 | `test/engine.test.mjs`「worktree:'on' + 非 git → 400」「auto 不擅自建」；`test/worktree.test.mjs` 路径越界拒绝 |
| R6 | `implemented` | `src/executor.js` `normalizeExecutor()` / `buildCodexArgs()` / `parseCodexLine()` / `runExternalExecutor()`；`src/engine.js` `_executorSpecOf()` / `_writeExecutorSchema()` / `_runExternalNode()`；`src/model.js` `EXECUTOR` / `validateFlow()` | `test/executor.test.mjs`（13 组 / 81 条）；`test/engine.test.mjs`「engine v0.7 · 外部 executor（R6）」5 组 |
| R7 | `implemented` | `src/supervise.js` `planWake()` / `SupervisionScheduler`；`src/runtime.js` `createRuntime()` 的 `wakeRun()` / `evaluateRun()` / `enableSupervision()` / `supervisionReady`；`src/tools.js` `flow_supervise`；`src/index.js` `POST/GET /runs/<id>/supervision` | `test/supervise.test.mjs`（52 组 / 410 条）；`test/runtime.test.mjs`（22 组 / 178 条）；`test/tools.test.mjs`（36 组 / 345 条）；`test/host.test.mjs` supervision 路由组 |
| R8 | `implemented` | `src/supervise.js` `NODE_ALARM_DEFAULT_MS` / `parseNodeStatus()` / `NodeSupervisionScheduler`；`src/runtime.js` `nodeSelfCheckPrompt()` / `wakeNode()` / `nodeSupervision`；`src/engine.js` `_parseNodeStatus()` / `_rememberNodeStatus()` / `_armSelfCheck()` / `_registerNodeSupervision()` / `_unregisterNodeSupervision()` / `_unregisterRunSupervision()` / `parseAssistantStructured()`；`src/runlog.js` `NODE_STATUS_EVENT_KINDS` + `case 'node/status'`；`src/runstore.js` `normalizeNodeStatus()` / `readRunDetail()` 的节点 `title`；`src/tools.js` `nodeStatusOfRun()` / `blockedNodeAdvice()`；`src/index.js` `runNodeStatusOf()` / `runBindingFields()`；`src/client/flowlist.js` `nodeStatusOf()` / `nodeStatusEntries()` / `NodeStatusBlock()` | `test/supervise.test.mjs` 8.1–8.6（52 组 / 410 条）；`test/engine.test.mjs` ①–⑨（70 组 / 604 条中的节点闹钟组）；`test/runtime.test.mjs` 节点闹钟组（22 组 / 178 条）；`test/tools.test.mjs` `flow_watch` 组（36 组 / 345 条）；`test/runlog.test.mjs`（72 组，含 2 组 node/status）；`test/host.test.mjs`（41 组，含 GET /runs 三处 nodeStatus）；`test/render.test.mjs`（70 组，含节点状态区块）；`normalizeNodeStatus()` 暂无独立单测（由 host 组间接覆盖） |

**已知边界**（如实列出）：`removeWorktree()` 目前没有 HTTP / 模型工具入口；`injected` 会话形态由注入方
负责，引擎不承诺其顶层性；跨进程 supervision 只按落盘 `lastWokeAt` 避重，不提供分布式锁。
节点闹钟只在内存、重启不恢复；外部 executor 节点不挂；`nodeStatus` 已下发到 Host 三处接口，
客户端在运行详情「节点状态」区块只读展示（见 §11.4）。

## 11 节点闹钟（v0.8，R8）

> 用户要求：把 proactive 那套「定时唤醒」内建进流程，**自动给每个节点主管会话挂上**；
> 到点让它确认是否完成，并**上报结构化的完成状态**，让流程按结构化数据判断状态流转。

### 11.1 归属、生命周期与到点动作

- **两个调度器、两个定时器**：`createRuntime()` 同时建 run 级 `SupervisionScheduler`（§7）与
  节点级 `NodeSupervisionScheduler`（`src/supervise.js`）；两者各 `start()` 一个 `setInterval`
  （默认 15s，节点级可用 `nodeSupervisionIntervalMs` 覆盖），都 `.unref()`，
  `runtime.dispose()` 里两个都 `stop()`。它们共享 `now` / `log` / `setInterval` 注入，
  但**不是一个 tick**，扫描与失败计数互不影响。
- **默认间隔**：`NODE_ALARM_DEFAULT_MS = 120_000`；`register()` 时
  `nextDueAt = now + intervalMs`，对外字段一律 ISO-8601 字符串；单条登记可用 `intervalMs` 覆盖。
- **登记**（只对节点主管会话）：
  - `_createNodeSession()` 在 `agents.create` 成功后立即
    `_registerNodeSupervision(runId, node, attempt, sessionId)`；
  - `_followupNodeSession()` 复用会话（打回重跑 / 外部消息二次激活）时也先登记；
    同一 `sessionId` 再 `register()` 是**刷新**：重排 `nextDueAt`、更新 `nodeId` / `attempt`、
    `enabled=true`、清 `failures` / `lastReason`，**不叠加第二条**，累计 `wakes` 保留；
  - 登记失败只写 warn，不影响节点执行。
- **注销**：
  - attempt 结束（passed / rejected / failed / 中止）在节点执行 `finally` 里
    `_unregisterNodeSupervision(attemptSessionId)`；`sessionId` 为空（外部 executor）时安全 no-op；
  - run 收尾两处都会 `unregisterRun(runId)`：引擎 `_disposeRunSessions()` 与 runtime
    `settleInstance()`；`dispose()` 只停定时器；
  - 返回值：`unregister(sessionId)` → boolean；`unregisterNode(runId, nodeId)` /
    `unregisterRun(runId)` → 摘掉的条数。未登记 / 空 id / 调度器抛错一律幂等吞掉。
- **到点动作**（runtime 注入 `wakeNode(entry)`，`src/runtime.js`）：
  1. `ctx.get('agents')` 不可用 → `{ action:'skip', reason:'no-agents-service' }`；
  2. `agents.get(sessionId)` 拿不到活会话 → 有 `agents.resume` 就
     `agents.resume({ resumeSessionId })`，仍拿不到 → `skip`（`no-agent`）；没有 `resume`
     → `skip`（`no-resume`）。**`resume` 抛错**才计一次失败；
  3. 会话 `status === 'idle'` 且有 `followup` → `followup`（起一个自审回合）；
     否则有 `inject` → `inject`（不新开回合，避免自审混进节点结论）；两者都没有 →
     `skip`（`no-delivery`）；
  4. 投递统一走 `buildFollowupPayload`（与收件箱同结构，`from:'flow-studio'`）。
- **返回契约**：`wake(entry)` 必须返回 `{ action: 'inject'|'followup'|'skip', reason? }`；
  缺 `action` / 未知值 / `null` / 抛错都算一次失败。
- **注意 skip 不是失败**：拿不到会话 / 没有投递通道都走 `skip`（算成功、不清 `wakes`），
  所以「会话一直拿不到」不会触发停摆；停摆只由 `resume` / `inject` / `followup` 抛错或
  返回非法形状触发。
- **推进与计数**：`inject` / `followup` → `wakes+1`；`skip` → **`wakes` 不加**，但算成功
  并清 `failures`；三者都推进 `nextDueAt`；失败也推进（避免同一 due 每轮重试刷屏）。
- **停摆**：连续 `maxFailures`（默认 3）次失败 → `enabled=false`、
  `lastReason='wake-failed: …'`，此后不再 `wake`，但条目**留在 `list()` 里可查**；
  成功一次把 `failures` 清零。

### 11.2 自审提问与结构化回报

`nodeSelfCheckPrompt(entry)` 固定包含 `runId` / `nodeId` / `attempt`，要求「只用一个 json 围栏
代码块回报，不要做别的事」，并写明「state=done 且 verdict 有值表示你认为该节点已完成；
不确定就写 working，不要谎报完成」（全文 ≤500 字，测试有断言）。

回报示例与 `parseNodeStatus`（`src/supervise.js`，纯函数，坏输入返回 `null`、绝不抛错）：

| 字段 | 解析规则 |
|---|---|
| `state` | `working / done / blocked / failed`；先 `trim`，**区分大小写**，其它值 → `working` |
| `progress` | 真实数字才认；`Math.round` 后夹到 `0..100`；数值字符串 / 布尔 / `null` → `0` |
| `summary` | 非字符串 → `''`；超 2000 字符截断 |
| `members` | 数组最多 20 项；非对象丢弃；`name` / `note` 去空白，非字符串 → `''`；`state` 同上四值，非法 → `working` |
| `blockers` | 数组最多 20 项；非字符串 / 空串丢弃；每项去空白并截到 200 字符 |
| `verdict` | 只认 `pass` / `reject`（trim 后精确匹配），其它 → `null` |
| `nodeId` | 非空字符串才保留，否则 `null` |
| `attempt` | 非负整数才保留（含 0），否则 `null` |

- 解析顺序：先按出现顺序取 json 围栏 / 无语言围栏的正文；围栏都不成时，回落到「去掉围栏后
  首个 `{` 到末个 `}`」的裸 JSON。围栏语言大小写不敏感，非 `json` 围栏忽略。
- **落三处**（`_rememberNodeStatus`）：
  1. `node/status` 事件（追加，历史可查；`traceId` / `nodeId` / `attemptId` 由引擎按当前绑定写）；
  2. `live.nodeStatus` 与引擎内存 `nodeStatus`（同一节点只留最新，最多 200 个节点，超出淘汰最早登记的）；
  3. `run.json.nodeStatus`（由 `_patchRunBinding` 在 live 刷新后补写，runstore 白名单已收）。
- `node/status.data` 白名单（`src/runlog.js` 的 `case 'node/status'`）：

| 字段 | 规则 |
|---|---|
| `state` | **必填**，上述四值 |
| `progress` | **必填**，整数 `0..100`；越界整条拒绝 |
| `summary` | 可选字符串，≤2000，超长截断 |
| `verdict` | 可选 `pass` / `reject` |
| `source` | 可选，只认 `self-check`（引擎恒写） |
| `nodeId` | 可选，合法节点 id；引擎先删非法值，再用事件顶层 `nodeId` 兜底 |
| `attempt` | 可选，≥1 的整数；<1 由引擎先删 |
| `members` | ≤20 项；每项 `name` / `note` ≤200（空 `note` 不写）、`state ∈ {working,done,blocked}`（未知→`working`） |
| `blockers` | ≤20 项；每项非空字符串、≤200 |

- `run.json.nodeStatus[nodeId]` 的落盘形状（`src/runstore.js` `normalizeNodeStatus`）：
  `{ state, progress, summary, verdict, at }` + `members: [{ name, state }]` + `blockers: [...]`。
  同一节点只留最新；状态非法回落 `working`，`progress` 夹到 `0..100`，`summary` ≤2000，
  `verdict` 非 `pass|reject` 置 `null`，`members` / `blockers` 各 ≤20 / 每项 ≤200，最多 200 个节点。
  引擎快照写进 run.json 的 `members` 只有 `name` / `state`；`note` 只保留在事件里（runstore
  若读到 `note` 也会保留，但引擎不写）。

### 11.3 用结构化状态驱动流转

- 节点还在等 `whenIdle` 时，当前 attempt 的 `node/status` 若 `state==='done'` 且
  `verdict ∈ {pass, reject}` → 作为**提前完成信号**与 `whenIdle` 竞速（`_armSelfCheck` /
  `selfChecks`，先到先得）：
  - 自审先到：用 `{verdict, summary}` 继续走既有结构化结论路径；`verdict==='reject'` 时用
    `summary` 作 `rejectReason`（空则写「自审回报判定打回（self-check）」）；`node/end.extra`
    记 `completedBy:'self-check'`（passed 与 rejected 都记）；
  - 原 `whenIdle` 继续在后台等完，失败只 warn，不阻塞主流程。
- **不能替代结构化 verdict 的合法性**：自审只给 `done` 但 `verdict` 非法 / 缺失时不发信号
  （测试 ⑥）；回合结束时输出仍要能解析成合法结构化结论，否则照旧
  `StructuredOutputError`，宁可不通过也不假装通过。
- **自审块不会被当成节点结论**：`parseAssistantStructured()` 优先返回带
  `verdict ∈ {pass,reject}` 的对象；`state` 是四值枚举且 verdict 非 pass/reject 的状态块
  会被 `isNodeSelfCheckBlock()` 跳过（同一条消息里状态块 + 正式 verdict 块时取后者，测试 ⑨）。
- `state==='blocked'` 且**最近两条** `node/status` 的 `progress` 相同（且 run.json 最新进度与
  事件最新一条一致）→ `flow_watch` 在 `recommended` 里追加
  「节点 X 报告 blocked 且无进展，建议先看它卡在哪」（`blockedNodeAdvice`，`src/tools.js`）。
  **审计本身不读 `nodeStatus`**，所以它只加建议、不会把 verdict 改成 `stalled`。

### 11.4 可见性

- `flow_watch` 返回 `nodeStatus`（run.json 的最新快照，缺省 `{}`），并可能带上述 `recommended`。
- `GET /runs` 列表行、`GET /runs/<id>` 详情、`GET /runs/<id>/summary` 都带 `nodeStatus`
  （`src/index.js` `runBindingFields()` → `runNodeStatusOf()`，缺省 `{}`）。
- 运行中引擎把最新快照同步进 `live.nodeStatus`；`run.json.nodeStatus` 由 live 刷新后的
  `_patchRunBinding()` 补写。
- `node/status` 与其它节点事件同 seq 排序，可在事件流 / 日志抽屉的完整事件里看到。
- **客户端只读展示**（`src/client/flowlist.js` `NodeStatusBlock()`）：运行详情头部「节点状态」区块，
  每个上报过的节点一行——标题（`GET /runs/<id>` 的 `nodes[].title`，拿不到退回 `nodeId`）、
  状态徽标（进行中 / 完成 / 阻塞 / 失败）、`progress%` 进度条、`verdict` 徽标、`members`
  （名字 · 状态；`note` 仅当 run.json 里有时显示——引擎快照不写 note）与 `blockers`
  （只列前 3 条 + 「等 N 条」，完整内容在 title）；
  超过 6 个节点（`NODE_STATUS_SCROLL_AT`）区块内部滚动；老 run / 坏形状整块显示
  「节点状态：暂无自审上报」。展示层会再收敛一次（state 小写、progress 取整夹取、坏条目丢弃）。
- **事件流展示仍有缺口**：日志抽屉的 `WATCH_EVENT_KINDS` / `EVENT_KINDS` 不含 `node/status`，
  该事件出现在完整事件列表里时会显示「未识别事件类型（node/status）」；状态区块不依赖它。

### 11.5 已知边界与不做什么

- **只在内存**：`NodeSupervisionScheduler._nodes` 不落盘，没有 `run.json.nodeSupervision`；
  进程重启后**不会恢复**节点闹钟（`runtime.supervisionReady` 只恢复 run 级 supervision）。
  只有新引擎再次推进某个节点（`agents.create` 或 `_followupNodeSession`）时才会重新登记；
  崩溃残留的 running run 由 `sweepStaleRuns()` 收口成 failed，不会带着旧闹钟继续跑。
- **外部 executor 节点不挂闹钟**：没有节点会话可叫醒，`_runExternalNode()` 不登记，
  `attemptSessionId` 为空，注销入口 no-op；这类节点也不写 `nodeStatus`。
- **采集不校验回报来源**：`handleSessionEvent` 对节点主管会话的任意 assistant JSON 都调
  `parseNodeStatus`；因此节点正常回合的结构化结论（只有 `verdict` / `summary`）也会被记成一条
  `state:'working', progress:0` 的 `node/status`，并覆盖该节点的最新快照。自审回报没有独立来源标记
  （`source:'self-check'` 是引擎加的，不是模型给的）。
- **审计不消费节点状态**：`audit.js` 不读 `nodeStatus`，blocked 无进展只在 `flow_watch`
  的 `recommended` 里提示（§11.3）。
- **日志抽屉不识别 `node/status`**：运行详情「节点状态」区块正常展示（§11.4），但日志抽屉的
  事件摘要表还没收录该 kind，完整事件列表里会显示「未识别」。
- run 收尾后不再叫醒节点会话（条目随 attempt / run 注销）；自审不替节点写产物、
  不改节点提示词内容，只收集状态。
