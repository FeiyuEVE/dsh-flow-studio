# 06 · 执行引擎（v0.4）

> 本册定义「图怎么变成真跑」：run 生命周期、主循环、提示词、结构化产物、事件映射、用量采集、
> 取消与失败、接口与客户端控制、以及怎么在没有真模型的情况下做 Docker 测试。
> 依赖 05 的事件契约（本册只规定**谁在什么时候写哪条事件**，不重新定义事件格式）。
>
> v0.7 增补：§17 外部 executor、§18 内建 supervision；§1 / §2 / §4.1 / §8 / §13.5 / §15 / §16
> 已按 v0.7 实现更新。

## 1 目标与非目标

**要做**：一次 run 从开始节点沿 `next` 边推进；每个阶段节点起一个节点主管会话（v0.7 起默认走
`ctx.agents.create` 的**顶层会话**，见 §16），用到该节点配置的角色/任务/产物/skill；节点返回结构化判定；判定 `reject` 时沿 `reject` 边回退、
目标节点 `attemptId+1` 重跑；全程按 05 写事件，指标与抽屉自动出数；可停止。

**不做（v0.4 范围外）**：并行分支（同一层多个可执行节点）、条件边、运行中改图、跨 run 断点续跑、多人协作。

## 2 run 生命周期

`run.json.status` 取值：`pending`（建了没跑）→ `running` → `done` | `aborted` | `failed`。
另加 `live` 对象（运行中才有意义）：

```json
"live": {
  "currentNodeId": "n_dev",
  "attempt": 2,
  "round": 3,
  "since": "2026-11-06T08:00:00Z",
  "lastEventSeq": 142,
  "phase": "model"          // model | tool | spawn | idle
}
```

- 到 `end` 节点且全部阶段通过 → `done`。
- 调用 `stop` 或进程取消 → 中止在飞请求，写 `run/end{status:'aborted'}` → `aborted`。
- 任一节点 `failed`、超时、或超 `maxRounds` → 写 `node/end{status:'failed'}` 与 `run/end{status:'failed'}` → `failed`。
- 并发按 run 不设上限（v0.7）：`src/runtime.js` 为每个 runId 建一个 Engine 实例并行跑；唯一 409 =
  **同一个 runId 已在跑**；跨进程单写者仍由 run 目录的 `lock.json` 租约保证（§13.3）。

### 2.1 v0.7 持久化绑定字段

`run.json` 另有三组字段，随 start 一次写入、run 内只读。**最终裁决在 `engine.start`**：
HTTP 路由与 `flow_start` 只做形状校验（workspace 必须是绝对路径、worktree 必须是 `auto|on|off`）
和参数传递，不自己决定隔离。

| 字段 | 形状 | 取值 / 语义 |
|---|---|---|
| `workspace` | `{ id, path, realpath, isGit, gitRoot }` | `id = sha256(realpath)` 前 12 位小写 hex；`gitRoot` 是 `git rev-parse --show-toplevel` 的结果（仓库根工作区等于 `realpath`；子目录工作区指向上层仓库根且 `isGit=false`；非 git 仓库为 null）；显式 workspace 不可用 → 400 |
| `worktree` | `{ enabled, reason, decidedBy, path, branch, baseCommit, createdAt }` | `decidedBy` 恒为 `initiator`；未启用时 `path / branch / baseCommit / createdAt` 均为 null；`reason` 见下表 |
| `sessionMode` | `'top-level' \| 'legacy-subagent' \| 'injected' \| 'stub' \| 'unavailable'` | 本次 run 节点会话的真实形态；不把降级路径谎称 top-level |

`worktree.reason` 的确定取值：

| reason | 何时出现 |
|---|---|
| `git-workspace` | 工作区是 git 仓库根，`auto` / `on` 建成功 |
| `not-a-git-repo` | `auto` + 工作区不是 git 仓库根（含子目录：`isGit=false && gitRoot!=null`） |
| `disabled-by-initiator` | 发起方传 `worktree:'off'` |
| `auto-without-initiator` | 没有发起方工作区（`options.workspace` / cwd / 会话 header.cwd 都没有），只能回落 `process.cwd()`；`auto` 不擅自建 worktree |
| `create-failed: <原因>` | `auto` 下 `git worktree add` 失败（`enabled:false` + 一条 warn），绝不假装已隔离 |

`run.json.startOptions` 是**创建 run 时**记下的发起参数（`{ workspace?, worktree? }`，不在
runstore 白名单里），只用于 `POST /runs/<id>/start` 把参数交给 `engine.start`；它不是第二份
权威记录。run 一旦开始，带不同 `workspace` 再 start → 400（「该 run 已绑定工作区，不能中途更换」）；
没有 PATCH 路由。`sessionMode` 的判定见 §16.2.1。

## 3 主循环

```
start(flowSnapshot):
  写 run/start{flowId, flowName, nodeTotal=阶段数}
  node = start 节点之后的下游节点；round = 0
  while node 不是 end 节点:
    round++
    attempt = 该节点已有尝试数 + 1
    写 node/start{title, mode, model, skills}
    result = await executeNode(node, attempt, 上游产物摘要, 打回上下文)
    # 节点执行抛错（超时 / 崩溃 / 结构化输出不合格）先重试，默认 1 次，见 §9；
    # 重试用尽才写 node/end{status:'failed'}，并跳出循环收口 run/end{status:'failed', failedNodeId}
    写 node/end{status: result.verdict === 'pass' ? 'passed' : 'rejected', durationMs}
    if result.verdict === 'reject':
      target = 选中的 reject 边目标（见 §5.3）
      写 reject/trigger{edgeId, fromNodeId, toNodeId, reason}
      if 该目标节点的尝试数 >= node.maxRounds: 失败收尾
      node = target; continue
    node = 沿 next 边的下一个节点
  写 run/end{status:'done'}
```

## 4 节点执行

### 4.1 单 agent（`mode='single'`）
1. 拼提示词（§6）；
2. 默认路径：`ctx.agents.create({ sessionId: nodeSessionId(runId, node.id, attempt), meta:{ cwd, agentPreset? }, agentOptions })`
   建一个**顶层会话**（绝不传 `parentAgent` / `meta.parentSession` / `meta.origin` / `delegationDepth`，
   否则会从顶层会话列表消失；详见 §16.2）；
3. `handle.agent.followup(buildFollowupPayload(...))` → `await handle.agent.whenIdle()` → 从该会话
   最后一条 assistant 消息解析 `structured`；句柄留到 run 收尾统一 `dispose()`，不在节点结束时释放
   （节点可能被二次激活；`dispose()` 只关句柄、不删日志，见 §16.2.1）。

没有 `ctx.agents.create` 的旧宿主才退回 `ctx.subagents.startActivation({ provider:'spawn', … })`
（`sessionMode:'legacy-subagent'`），这条路径不是 v0.7 的默认实现。

### 4.2 团队（`mode='team'`）
lead 会话照 §4.1 起，团队分工写进提示词（每个成员的名字/角色/任务各一段），并要求 lead 用子 agent 工具分发；
成员会话通过 `parentSessionId === leadSessionId` 识别，事件按 `memberId = <nodeId>:<序号>` 归属。
lead 不返回成员级明细时，摘要标 `membersPartial: true`，不编造。

### 4.3 结构化输出（`outputSchema`）

```json
{
  "verdict": "pass | reject",
  "summary": "一句话结论（≤400 字）",
  "artifacts": [{ "name": "需求清单.md", "content": "…" }],
  "findings": [{ "id": "F1", "severity": "P0|P1|P2", "title": "…", "status": "open|accepted|fixed|verified|dismissed" }],
  "checks": { "ruleSetId": "…", "ruleSetVersion": "…", "executor": "…", "passedChecks": 12, "totalChecks": 12 },
  "acceptance": [{ "itemId": "R1", "status": "pass|fail|skip|na", "decidedBy": "auto" }],
  "tests": { "suite": "unit", "executed": 29, "passed": 29, "failed": 0, "skipped": 0 },
  "rejectTarget": "上游节点 id（可选，默认取最近一个 reject 边目标）",
  "rejectReason": "打回原因（reject 时必填）"
}
```

- 产物写进 `runs/<runId>/<nodeId>/artifacts/<attempt>/`，按 `artifact/write` 事件记录 `path`、`bytes`、`sha256`。
- `acceptance` / `tests` / `checks` / `findings` 落成 05 的事件，`quality` 才有证据可算（否则按契约是 `unknown`）。
- 结构不合格（缺 `verdict`）→ 视为节点失败并写 `node/end{status:'failed'}`，同时在事件 `extra.validationError` 里留原因。

## 5 打回

### 5.1 判定
`result.verdict === 'reject'` 才算打回；打回目标是**上游**节点，必须存在 `reject` 边，否则 run 失败并写原因。

### 5.2 目标选择
`result.rejectTarget` 若命中某条 reject 边的 `to` 就用它；否则取该节点所有出向 reject 边里**目标列最靠前**的那条。

### 5.3 轮次与上限
目标节点允许的重跑次数 = 目标节点的 `maxRounds`（默认 2）。超过 → `run/end{status:'failed', reason:'超打回上限'}`。
每次重跑都是新的 `attemptId`，旧 attempt 的结论在指标里按 05 §8.3 失效。

## 6 提示词

固定骨架（按顺序，全部中文）：

1. **你是谁**：`node.role`（空则用节点标题）；
2. **你负责什么**：`node.task`；
3. **期望产物**：`node.outputs`；
4. **必须加载的 skill**：逐个列 `skills[]`，要求先调用 skill 工具加载再动手；
5. **上游产物**：最近 3 个已通过节点的 summary 与产物路径，**外加最近 1–2 个产物的有界正文**
   （宿主在拼提示词前预读，单产物 ≤1200 字、总 ≤3000 字；只认记录里 attempt 对应的
   `<nodeId>/artifacts/<attempt>/` 目录，历史 attempt 的同名文件不会混入；读取失败 / 文件缺失 /
   超过大小上限降级为只给路径行，绝不抛错中断 run）；
6. **打回上下文**（仅 attempt>1）：上一轮判定、打回原因、上次 findings；
7. **输出格式**：明确要求返回 §4.3 的 JSON（`verdict` 必填、`reject` 必带 `rejectReason`），不要夹带正文产物以外的解释；
   并说明证据引用口径：验收 / 检查条目判 `pass` 时 `evidenceRef` 优先引用上游节点产物（跨节点才算独立复核），
   只引用本节点刚写的产物属于自证；可给多条证据，自己在产物里写「已通过」不算证据。
   模型给的 `evidenceRef` / `reportRef` 只是候选，引擎只透传通过校验的 run 内安全路径（见 §13.7）。

提示词长度上限 8000 字，超出按 §5 完整性优先截断：**先截「上游产物」段**（正文先丢、路径行与摘要尽量留），
再截任务；「输出格式」段是硬保留段。上游正文的 1200 / 3000 预算保证正常场景下不会触发二次截断。

## 7 事件映射（引擎侧必须写）

| 时机 | 事件 |
|---|---|
| run 开始 / 结束 | `run/start` / `run/end` |
| 节点开始 / 结束 | `node/start`（带 `skills[]`，这是覆盖率分母；重试时同一 `attemptId` 再写一条，`data.retry` / `retryReason` 留痕）/ `node/end` |
| 成员开始 / 结束 | `member/start`（`memberId` 必填）/ `member/end` |
| 模型调用 | `model/call`（`callId` 必填，四桶 usage） |
| assistant 可见文本 | `agent/message`（脱敏 + 截断 + 同会话去重，见 §13.12） |
| 工具调用 | `tool/call` |
| skill 加载 | `skill/load`（`ok` 布尔） |
| 产物落盘 | `artifact/write` |
| 打回 | `reject/trigger` |
| 审查结论 | `review/finding` / `review/verdict` |
| 规范检查 | `check/form` |
| 验收条目 / 测试报告 | `acceptance/verdict` / `test/report` |

## 8 用量采集

- 订阅 `session/event`（`{ global: true }`），只关心本 run 已知的会话 id（引擎在节点会话建立后把 `sessionId → {nodeId, attemptId, memberId}` 登记进内存映射）。
- `assistant/message.data.usage` → `model/call`，`callId` 取消息 id（无则用 `<sessionId>:<seq>`）；四桶照抄，`reasoning` 仅在 `≤ output` 时带上。
- `tool/call` 里 `name === 'skill'` → `skill/load`：参数 JSON 里的 `name` 是 skill 名，`ok` 取决于同 `callId` 的工具结果是否有 error。
- `tool/call` 其他工具 → `tool/call` 事件（只记名字与 `ok`，参数摘要 ≤200 字，不记全文）。
- **去重**：同 `traceId + callId` 后到整条替换（05 §3），重试不会重复计 token。
- 归属：成员会话的用量记到该成员的 `memberId`；lead 会话记 `memberId: null`。

## 9 取消、超时、失败

- 每次 run 一个 `AbortController`；`stop` → `abort()`，在飞的 `startActivation` 用 `signal` 中断，已写事件保留，收尾写 `run/end{status:'aborted'}`。
- 单节点超时默认 20 分钟（可按 `FLOW_STUDIO_NODE_TIMEOUT_MS` 覆盖）；超时算**一次失败**，走与其它异常相同的重试路径。
- **节点级失败先重试**：默认重试 1 次（共 2 次尝试），`FLOW_STUDIO_NODE_RETRIES` 覆盖并钳制在 0–5。
  重试**不新增 `attemptId`**（不消耗打回目标 `maxRounds`），而是用同一 `attemptId` 再写一条
  `node/start{data.retry, retryReason}` 留痕；`stop` / run 墙钟中止不重试。
- **失败隔离**：重试用尽 → 只判该节点失败：写 `node/end{status:'failed'}`（`data.retries`、
  `extra.reason`/`extra.timeout` 等），再写 `run/end{status:'failed', reason, failedNodeId}` 正常收口。
  已通过节点的事件与产物完整保留；`summarize()` / `readRunDetail()` 在 failed run 上照常可算；
  live 快照置 `null`，不留 running 节点。
- 打回循环里的失败同样适用；`maxRounds` 耗尽仍按 §5.3 / §13.10 的语义先写目标节点 `node/end failed`。
- 其它异常（成环 / 步数 / 断头路等）都要落到 `run/end{status:'failed', reason}` 并把细节写进事件 `extra`，不允许静默停住。
- 引擎崩溃（进程重启后残留 `running` 的 run）：启动时把超过 30 分钟无新事件的 run 标 `failed` 并注明「引擎中断」，不自动续跑（v0.4 不做断点续跑）。

## 10 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/runs/<runId>/start` | 开始执行；返回 202 `{run}`；已有运行中 run → 409 |
| POST | `/runs/<runId>/stop` | 停止；返回 `{run}`；不在跑 → 409 |
| GET | `/runs/<runId>` | 已含 `live` 字段（§2） |

不做 SSE：客户端运行中每 2s 轮询 `GET /runs/<id>` 与 `/summary`，停止后停轮询。

## 11 客户端

- 顶栏：`运行` / `停止` 按钮（按 run 状态切换）、当前节点与 attempt 显示；
- 节点卡：运行中显示 `运行` 环（business 色）、通过 `✓`、被打回 `↺n`、失败 `✕`（形状 + 文字，颜色只加速）；
- 抽屉：运行中自动展开并 2s 刷新；`live.currentNodeId` 对应事件高亮；结束后停留展示结论（不自动关闭）。

## 12 可测性（Docker 测试的关键）

- 引擎做成**依赖注入**：`createEngine({ activate, now, readUsage, signal })`。`activate` 是
  **dsh 节点会话**的唯一模型入口，测试传桩函数即可；外部 executor（§17）走独立子进程，不经过 `activate`。
- **测试钩子**：环境变量 `FLOW_STUDIO_STUB_ENGINE=1` 时，Host 用内置桩执行器（按节点标题匹配预设剧本，产出 pass/reject 与合成 usage）。**只在测试台用**，`/health` 返回 `engine: "stub"` 让人一眼看出不是真跑。
- 单测（`test/engine.test.mjs`）：单节点通过、两节点通过、打回一轮后通过、超 `maxRounds` 失败、停止中止、结构不合格失败、用量归属与去重。
- Docker e2e（测试台）：装包 → 建 run → `start`（stub 模式）→ 轮询到 `done`/`failed` → 断言事件序列、`quality.state`、`progress.ratio`、`reject/trigger` 计数、`attemptId=2`、drawer API 数据齐全。

---

## 13 v1.1 修复契约（三路独立评审「驳回」后追加，优先于上文冲突处）

### 13.1 鉴权（安全 B1）
插件路由**必须**在 handler 最前面接回宿主鉴权：`const rejection = ctx.get('connection')?.requestRejection(req)`；
拿到数字（401/403）即原样返回；**拿不到 `connection` 服务时 fail-closed**（503 + 可读原因），不再只依赖 `Origin`。
`FLOW_STUDIO_TOKEN` 作为第二道可选校验保留（≥16 字符，否则启动即拒绝并告警），且只认 `Authorization: Bearer`。
`GET /health` 的 `dir`/`runsDir` 只在「已通过鉴权」或「回环请求」时返回，否则只给 `auth`/`engine`/`version`。

### 13.2 run 生命周期（M1）
`createRun` 写 **`pending`**；`start` 必须调用 `startRun()` 做原子 `pending -> running`（同时写 `startedAt`），
不是 pending 一律 409。`sweep` 只处理 `running`。`start` 不能用 `eventCount===0` 判断「没开始过」，
要用持久化的 `started` 标志（`run.json` 字段，`startRun` 置位）。

### 13.3 单写者租约（M5）
run 目录放 `lock.json`（pid、host、heartbeatAt、ttlMs）；`start` 先抢租约，抢不到 409；
引擎每 30s 续租；异常退出后由 `sweep` 清理过期租约并把该 run 标 `failed`（reason 含「引擎中断」）。
`DELETE /runs/<id>` 在该 run 持有租约时返回 409。

**互斥必须是跨进程的**（复审 BLOCKER）：同进程 `withLock` 挡不住第二个 dsh 进程 / 另一个 host。
- 没租约：`lock.json` 走 `open(..., 'wx')`（O_EXCL）原子创建，建成后立刻回读复核
  `pid/host/acquiredAt` 三者都对得上才认账（防止刚建好就被并发接管者搬走）。
- 租约过期：**先跑一次「接管选举」**——每个想接管的进程写一个
  `lock.takeover-<毫秒>-<pid>-<序号>` 意图文件，等一个选举窗口（15ms），
  读目录里所有未过期意图按文件名全序比较，最小者获得接管权；只有赢家可以删旧锁、O_EXCL 建新锁，
  输家等一个窗口后重读（通常已被新租约挡住 → 409）。意图文件被赢家立即撤回，超过 5s 的视为崩溃残留。
- **禁止把「读 → rename 搬走 → 创建」当成 CAS**：读到的瞬间锁可能已被别人换成新的，
  搬走的就是别人的新锁，于是两个进程都以为自己赢。`startRun` 的 `start.lock` 同理（同一套选举清理陈旧锁）。

### 13.4 事件额度与写盘失败（M1/M2）
`run/start`、`run/end` 享有**保留额度**（总上限 − 64），普通事件不得占用；
任何致命失败都必须能落终态：事件写失败时直接把 `run.json` 原子改成 `failed` 并写 `.error` 侧车文件，
`GET /runs/<id>` 返回 `storageError`。启动时修复「jsonl 有 `run/end` 但 `run.json` 不是终态」的不一致。

### 13.5 主循环终止性（B2）
`start` 前调用 `validateFlowForRun`，**errors 一律 400**（不允许带着断头路/成环/多出边开跑）。
该函数是**启动侧的严格口径**：结构规则之外，还包含 executor 的两条规则（custom 缺
`executorCommand`、外部 executor 配 `team`）；流程保存时这些 errors 只报告、不拦保存，见 §17.1。
v1.1 额外规则：恰好一个 start、至少一个 end；每个非 end 节点**恰好一条 next 出边**（多出边直接 error，
不做「取最左」）；reject 目标必须在上游且存在；所有阶段必须能到达 end。
循环内维护 `next` 访问集：重复访问同一节点且不是打回 → `node/end failed` + `run/end failed`；
`selectNextNode` 返回 null 且当前不是 end → failed，**不得 done**。
run 级预算：`maxTotalSteps`（默认阶段数 × 3）、墙钟上限（默认 2 小时，`FLOW_STUDIO_RUN_TIMEOUT_MS`），超限 abort + failed。

### 13.6 并发启动（B1 引擎侧）
`start` 的第一个 `await` 之前必须同步占位（`this.starting` 或带 controller 的 `active` 占位），失败再释放；
进入临界区后**重读 `run.json`** 校验 `started===false && status==='pending'`；锁是模块级（跨引擎实例）。

### 13.7 证据命名空间与防伪（B3/B4/M4）
- 引擎写事件前把标识加上节点前缀：`findings.id = <nodeId>:<原始 id>`、`acceptance.itemId = <nodeId>:<原始>`、
  `tests.suite = <nodeId>:<原始>`、`check.ruleSetId` 缺省也带 `<nodeId>:`；同一 run 内重复即判结构不合格。
- 打回上下文必须带上一轮**未关闭 finding 的 id**，并明确要求「复用同一 id 更新 status」。
- 上一轮的 `acceptance/tests/checks` 标识必须随打回上下文下传，要求本轮**全量重报**；
  聚合时若某个旧的 fail 标识在本轮没有被重新判定 → 该项 `unknown`（不允许被「少报」洗绿）。
- 证据可信度：`acceptance/verdict`、`test/report`、`check/form` 由模型自述产生的，事件 `extra.provenance='model-claim'`；
  `reportRef`/`evidenceRef` 必须在 run 目录内、文件真实存在、且与某条 `artifact/write` 的 `path+sha256` 对上；
  对不上 → `unknown` 并列入 `missing`。**桩（stub）run 一律 `quality.state='unknown'`**，`label` 前缀「桩」。
- m7 证据引用透传：模型可在 `acceptance[].evidenceRef` / `checks.reportRef` / `tests.reportRef` 里引用**上游节点产物**
  （跨节点引用在聚合层算 peer，才算独立复核；引用本节点产物是 self）。引擎只透传校验通过的安全路径：
  必须是 run 目录内相对路径、对应本 run 的 `artifact/write`、文件存在且 sha256 一致；任一失败则退回引擎自己落盘的
  `acceptance.json` / `checks-report.json` / `test-report.json`（审计文件本身永远保留），并在事件 `extra` 写
  `evidenceRefRejected` / `reportRefRejected` 说明原因（runlog 的 data 白名单会丢弃未知字段，所以标记放 `extra`）。

### 13.8 桩的可见标记（M7）
`FLOW_STUDIO_STUB_ENGINE=1` **且** `FLOW_STUDIO_TESTBED=1` 才启用（否则忽略并在日志告警）。
`run/start.data.engine`、`run.json.engine`、`GET /runs` 列表、`/health.engine` 都体现 `stub`；
客户端对 stub run 显示醒目 badge「桩数据，不是真实证据」。

### 13.9 预算与脱敏（M3/m3）
单产物上限 1 MiB、单 run 产物总预算 64 MiB：超限截断写盘并在 `artifact/write` 标 `truncated:true, originalBytes`。
`tool/call` 的 `argumentsDigest` 必须脱敏（`Bearer …`、`sk-…`、`token|password|secret|api_key` 值、超长串），
不得把凭据原文写进日志与导出。

### 13.10 打回语义（M2/M3/M4）
`maxRounds` = **允许的重跑次数**（默认 2）：`maxRounds=1` 表示「允许重跑 1 次」。
超限时要先写目标节点 `node/end{status:'failed', reason:'超打回上限'}`，再写 `run/end failed`。
重跑节点的「上游产物」只能取**沿 next 边能到达当前节点**且当前有效的 passed 记录，打回时把失效路径从 passed 集合移除。

### 13.11 模型覆盖（M5）
`node.model` 必须真正传给节点会话：默认路径是
`agents.create({ …, agentOptions: { model: node.model } })`；兼容 spawn 路径放
`request.agentOptions`。宿主不支持时启动前报错，不允许「界面能填、实际不生效」。

### 13.12 运行详情数据面（live 快照 + `agent/message`）

客户端在 run 进行中轮询 `GET /runs/<id>`（读 `run.json.live`）显示「agent 正在干什么」。引擎在每次
`_append()` 后由 `_persistLive()` 整体写回 `live`，run 结束置 `null`。字段与体积口径（全部有界）：

| 字段 | 结构 / 语义 | 上限 |
|---|---|---|
| `nodeTitle` / `nodeMode` | 当前节点标题；`single` / `team` | 200 字符 |
| `activeMemberId` | 正在产生事件的那个成员；`null` = lead | `checkMemberId` |
| `lastTool` | `{ name, startedAt, ok }`：`tool/call` 开始时写 `name`/`startedAt`、`ok=null`；`tool/result` 补 `ok` | name 200 字符 |
| `lastMessage` | `{ text, at, memberId }`：最近一条 `agent/message` 的可见文本 | text 200 字符 |
| `tokens` | `{ input, cacheRead, cacheWrite, output }` 本 run 累计四桶（互斥） | 非负整数 |
| `members` | team 节点已观察成员 `[{ memberId, name, role?, model?, state }]`；`state` ∈ `starting/running/done/unknown`，`member/start` 落盘后转 `running`，节点收尾转 `done` | ≤16 条 |

`tokens` 与 `computeTokens` 同口径：同一 `traceId + callId` 的用量按「后到整条替换」累计，避免重放把总量算重。
`members` 只在 team 节点有值，single 节点为空数组；不确定的状态写 `unknown`，不编造。

`agent/message` 的来源与加工：订阅 `session/event` 的 `assistant/message` → 从 `message.content` 里只取
`type:'text'` 的块（防御性兼容字符串 / `message.text`，提不到不发）→ `redactArguments` 脱敏 →
按码点截到 ≤2000 字符（再以 UTF-8 4 KiB 兜底，保证单条事件 < 8KB）→ 同会话连续相同文本去重（hash 表 ≤64）→
写 `agent/message{ role:'assistant', text, truncated, provider?, model? }`，事件级 `memberId` 沿用 binding。
原有 `model/call` 映射不变：有 `usage` 才写，token / quality 口径不受新增事件影响。

---

## 14 工作流健康审计

> 目的：让「启动流程的主 agent」在定时唤醒时，只读模板 / 事件流 / run.json 三样东西，
> 就能判断**整条流水线**是否在正常运转（偏航、卡死、打回死循环、并发乱序），而不是逐个节点翻细节。
> 实现：`src/audit.js` 的纯函数 `auditWorkflow(input)`；不改事件格式、不碰 fs、不 import engine/index。
> 模型工具 `flow_watch` 的返回就是本节契约（见 §15），`supervision.nextCheckSeconds` 直接取本节的建议值。

### 14.1 输入

```js
auditWorkflow({
  flow,                 // normalizeFlow 结果（nodes / edges；node.kind: start|stage|end，edge.kind: next|reject）
  events,               // runlog 事件数组（node/start、node/end、reject/trigger、run/start、run/end…）
  run,                  // run.json（status / startedAt / endedAt / failedNodeId…；缺失时按事件流推断）
  now = Date.now(),
  stallMs = 10 * 60 * 1000,        // 多久没新事件算卡死
  nodeTimeoutMs = 20 * 60 * 1000,  // 单节点跑多久算「有时限风险」
  maxRejectsPerEdge = 3,           // 同一条打回边触发几次算死循环
})
```

- 事件按 `seq` 升序重放（缺失 `seq` 退回 `ts`，再退回原顺序），事件对象只读、不改写；
- `flow` / `events` / `run` 任一缺失或类型不对都**不抛错**：能判的照判，缺的字段给 `null` / 空数组；
- 时间只用注入的 `now` 比较（接受毫秒数或 `Date`），便于测试与离线回放。

### 14.2 判据 → verdict → recommended

| 顺序 | 判据 | `verdict` | `recommended` | `nextCheckSeconds` |
|---|---|---|---|---|
| 1 | `run.status === 'pending'` | `pending` | `inspect` | 30 |
| 2 | `run.status === 'done'`（headline 带 `quality`） | `done` | `report` | `null` |
| 3 | `run.status === 'failed'`（说清失败节点与原因） | `failed` | `report` | `null` |
| 4 | `run.status === 'aborted'` | `aborted` | `report` | `null` |
| 5a | running：同一时刻同时存在两个已 `node/start` 未 `node/end` 的节点（**concurrency**） | `deviating` | `stop` | 60 |
| 5b | running：`node/start` 序列偏离模板 `next` 链，且不是打回目标（**deviation**） | `deviating` | `stop` | 60 |
| 5c | running：同一条打回边（`from→to`）累计触发 > `maxRejectsPerEdge`（**reject-loop**） | `looping` | `stop` | 60 |
| 5d | running：`idleMs > stallMs`（**stall**） | `stalled` | `inspect` | 60 |
| 5e | running：当前节点 `elapsedMs > nodeTimeoutMs`（**timeout-risk**） | `stalled` | `inspect` | 60 |
| 5f | running：`progress.ratio === 0` 且运行时长 > `stallMs`（**no-progress**） | `no-progress` | `inspect` | 60 |
| 6 | 以上都不成立 | `healthy` | `wait` | 180 |

- verdict 优先级：`deviating` > `looping` > `stalled` > `no-progress` > `healthy`；
  有 anomaly 时 `headline` 必须写清「哪一类、哪个节点」。
- **concurrency 归入 `deviating`**：引擎设计是串行的，出现两个未结束节点就是乱序 bug，按偏航处理。
- **timeout-risk 归入 `stalled` 类**：节点已超过单节点时限，再等就是超时失败；
  `headline` 会区分「无新事件」与「超时风险」两种成因。
- 终态（`done` / `failed` / `aborted`）按状态先收口：`anomalies` 只保留 `failed` 一条，
  不在终态上再拿运行期异常改 verdict。

### 14.3 输出字段

| 字段 | 语义 |
|---|---|
| `verdict` | `AUDIT_VERDICTS` 之一：`pending / healthy / stalled / looping / deviating / no-progress / failed / done / aborted` |
| `status` | `run.status` 原样；`run` 或该字段缺失时为 `null`（不拿推断值冒充） |
| `headline` | 中文一句话（≤120 字），可直接展示给用户；异常时含类别与节点名 |
| `progress` | `{ passed, total, ratio, nodes: [{ id, title, state, attempt }] }`；`ratio` 为 `null` 表示无法判定 |
| `plan` | `{ expected, actual, deviations }`：预期阶段 id 链 / 实际 `node/start` 顺序 / 偏航明细 |
| `currentNode` | running 时最近启动且未结束的节点：`{ id, title, attempt, elapsedMs, idleMs }`，否则 `null` |
| `rejects` | `{ total, byNode: [{ nodeId, title, count }], looped: [{ nodeId, title, count }] }` |
| `anomalies` | `[{ kind, nodeId?, detail }]`，`kind` ∈ `stall / timeout-risk / reject-loop / deviation / concurrency / no-progress / failed` |
| `quality` | `null` 或 `{ state, label }`（复用 `runlog.summarize` / `computeQuality`，没有事件证据时为 `null`） |
| `tokens` | `null` 或 `runlog.computeTokens` 的结果（四桶 + 按节点 / 成员分组） |
| `idleMs` | 距最后一条有效 `ts` 事件多久；没有事件时以 `run.startedAt` 起算 |
| `recommended` | `wait / report / stop / inspect`，与 verdict 的映射见上表 |
| `nextCheckSeconds` | 建议的下次唤醒间隔；`null` = 不必再查 |

### 14.4 判定细节

- **正常序列**：从 `start` 节点沿 `next` 边一直走到 `end`，途中经过的阶段节点序列即 `plan.expected`；
  没有 `start` 节点时把入口阶段算进链首，坏模板（断头路 / 成环）只降级成较短链路。
- **偏航**：按出现顺序看 `node/start`。正常应命中「下一个预期阶段」；`reject/trigger` 之后
  修改预期为 `toNodeId`，因此打回后从打回目标重跑**不算偏航**。既不是下一个预期节点、也不是打回目标的，
  记一条 deviation（`index` = 在 `actual` 中的下标，`expected` = 预期阶段 id，链已走完为 `null`），
  然后按实际节点重新对齐，避免一次跳过把后面整条链都算成偏航。
- **重试去重**：同一 `nodeId + attemptId` 的重复 `node/start`（06 §9 的节点级重试）只记一次，
  既不算两个阶段、也不算偏航。
- **打回死循环**：按「边」计数，`from→to` 相同即同一条边；`rejects.looped` 按**被打回节点**汇总，
  `count` 取该节点上超阈值边里的最大计数。
- **进度**：`passed / ratio` 复用 `runlog.computeProgress`（打回失效、旧 attempt 不计、skipped 不进分母）；
  `total` 优先取 `run/start.nodeTotal`，其次观察到的节点数，未开跑时退回模板阶段数（此时 `ratio` 为 `null`）。
- **节点状态**：`state` ∈ `pending / running / passed / rejected / failed / skipped / invalidated`；
  `running` = 已 `node/start` 未 `node/end`，`invalidated` = 被后续打回作废的旧 passed，`attempt` 为当前 attemptId（未开始为 0）。
- **currentNode**：取打开节点中启动最晚的那个；`elapsedMs` 从它最近一条 `node/start` 起算，
  `idleMs` 从该节点最近一条事件起算（顶层 `idleMs` 是全局口径）。
- **有界**：`anomalies` 最多 50 条、`plan.deviations` 最多 50 条、`plan.actual` 最多 200 条；
  事件可以到 20 万条，报告不跟着涨。

### 14.5 已知边界

- **只按事件流推断，不读子会话内部**：审计看不到 agent 正在想什么，只认已落盘的事件与 run.json。
- **只支持串行图**：引擎 v0.4 不做并行分支；真出现并行会被当作 concurrency / deviation 报异常。
- **事件窗口被截断时结论可能偏轻**：历史打回或节点启动不在窗口内，`rejects` 计数与 `plan.actual` 会不完整。
- **依赖同一个时钟**：`ts` 与 `now` 偏差过大会误判 stall / timeout-risk；Host 侧应传服务端时间。
- **`quality` / `tokens` 复用 `runlog.summarize`**：0 条事件时为 `null`；桩（stub）run 的质量仍是 `unknown`。
- **只报告、不动作**：`recommended` 只是建议，审计不停止 run、不重试、也不通知主人（由主 agent 按 verdict 决定）。

## 15 会话内启停（模型工具）

v0.4.2 之前只能从 Web 面板点「运行」。本节定义一组**模型工具**，让主 agent 在自己所在的会话里
直接开跑一个流程，并定时唤醒审查「整个工作流是否在正常运转」。工具实现在 `src/tools.js`，
注册在 `src/index.js`，测试在 `test/tools.test.mjs`（`node test/tools.test.mjs`）。

### 15.1 三步闭环

```
① flow_list / flow_start
     主 agent 在当前会话里启动 run
     → engine.start(runId, { parent: exec.agent, workspace: <调用方会话 header.cwd> })
     → 工作区 / worktree 由 engine.start 最终裁决并写进 run.json
     → 节点会话是顶层会话，cwd = worktree.path 或 workspace.path

② flow_start 启动成功后**自动开启内建 supervision**（返回 supervision.enabled=true）
     不需要再挂 proactive_set；到点由 runtime 的调度器唤醒发起会话
     只有 enabled=false（引擎不支持 / 登记失败）才回退到旧方式：
     proactive_set after_seconds = supervision.nextCheckSeconds
     prompt        = supervision.alarmPrompt（完整提示词，含 runId / flow_watch / proactive_reclaim）

③ 每次被唤醒 → flow_watch（runId）
     verdict 正常（healthy / running 类）→ 安静结束本轮，不打扰主人
     异常（stalled / looping / deviating / no-progress）或已跑完（done / failed / aborted）
       → 把结论与需要决策的点通知主人
```

工具描述（`description`）里必须写清这三步——那是模型唯一会读到的使用说明。
`alarmPrompt` / `nextCheckSeconds` 从 0.5.0 起保留，但 v0.7 的推荐路径是内建调度（§18）。

### 15.2 工具清单

| 工具 | 读写 | 入参 | 出参（成功） |
|---|---|---|---|
| `flow_list` | 只读 | `{ limit?: integer }`（默认 20、上限 100） | `{ ok, flows: [{ id, name, nodeCount, edgeCount, updatedAt }] }` |
| `flow_start` | 写（exclusive） | `{ flowId?, flowName?, task?, name?, workspace?, worktree? }`（`flowId` / `flowName` 二选一，都不给 → 失败并提示先 `flow_list`；`worktree ∈ auto/on/off`） | `{ ok, runId, flowId, flowName, status, workspace, supervision }` |
| `flow_watch` | 只读（`isConcurrencySafe`） | `{ runId? }`（省略 = 最近一次 run） | 审计结果原样 + `{ ok, runId, flowId, supervision }` |
| `flow_stop` | 写 | `{ runId: string }`（必填） | `{ ok, runId, status }` |
| `flow_supervise` | 写 | `{ runId: string, enabled: boolean }`（都必填） | `{ ok, runId, enabled, supervision, scheduler }` |

v0.7 一共 7 个模型工具：上面 5 个 + 收件箱的 `flow_send_message` / `flow_reply`（定义见 §16.8）。

命名规则：`flowId` 优先；没有 id 时按 `flowName` **精确匹配**，再退不区分大小写；同名多份 → 失败并列出候选 id
（让模型用 `flowId` 指定，而不是猜）。`task` 是用户这次要跑的任务原文，写进 `run.json.name`；显式 `name` 优先于 `task`。

### 15.3 `engine.start(runId, { parent, workspace, worktree })`

`engine.start` 的可选第二参数（v0.7）：

```js
engine.start(runId)                                  // 旧调用：行为不变
engine.start(runId, { parent })                      // 本会话作为发起方（Agent 对象）
engine.start(runId, { workspace, worktree })         // 显式工作区 / worktree 策略
```

- `parent` 只用于三件事：`workspace` 缺省时提供 `header.cwd` 作为候选（`source:'initiator-session'`）、
  记录 `startedBy`（`flow_send_message` 省略 runId 时取「本会话启动的最新 run」）、以及旧宿主兼容路径。
  **它不再传给 `agents.create`**：v0.7 的节点主管会话是顶层会话（§16.2）。
- `workspace` 优先于 `options.cwd`、构造时 `cwd`、会话 `header.cwd`；`worktree` 只接受
  `auto / on / off`，其它值 400。两者最终都由 `engine.start` 裁决并写进 `run.json`（§2.1）。
- 生命周期：`startParent` / `startCwd` / `startAgentPreset` 只活在一次 run 内，
  run 收尾（`_cleanupActive()`）清空，不影响下一次 `start`。非对象 `parent` 在进入临界区前
  以 400 拒绝，不留下占位运行态。
- 并发：v0.7 没有模块级 `START_LOCK`、没有并发上限。不同 runId 并行；同一 runId 的二次 start
  由 `src/runtime.js` 的注册表返回 409。

### 15.4 工作区来源与继承

v0.7 的默认路径不再靠子会话继承 `parent.cwd`，而是把工作区显式交给引擎裁决：

1. `flow_start` 未显式传 `workspace` 时，取 `exec.agent.session.header.cwd` 作为 workspace；
2. `engine.start` 解析成 `{ id, path, realpath, isGit, gitRoot }`，按 `worktree` 策略决定是否
   建 worktree，并把结果写进 `run.json.workspace / run.json.worktree`（§2.1）；
3. 节点主管会话的 `cwd`：worktree 开着用 `worktree.path`，否则用 `workspace.path`
   （`_sessionCwd()`）；外部 executor 用同一个 cwd。

旧兼容路径（没有 `ctx.agents.create`）仍走
`ctx.subagents.startActivation({ provider:'spawn', delivery:'caller', request:{ parent, cwd?, prompt, … } })`：
`request.parent` 是 **Agent 对象**，`request.cwd` 省略时继承父 agent 的工作目录。
返回值里的 `workspace.inheritedFrom` 是发起会话 id（取不到为 `null`），只用于向模型/用户交代
「从哪个会话启动」，不参与执行。

### 15.5 定时自审（`supervision`）

`flow_start` 与 `flow_watch` 都返回 `supervision`：

| 字段 | 语义 |
|---|---|
| `nextCheckSeconds` | 建议的审查间隔。`flow_start` 默认 180；`flow_watch` 优先用审计模块给的值，钳制在 30–900；终态（done / failed / aborted）为 `null` |
| `alarmPrompt` | 完整中文提示词（≥40 字），包含 `runId`、要调 `flow_watch`、healthy 就安静结束、异常或跑完才通知主人；终态时说明「不必再查」。0.5.0 起保留，作为内建调度不可用时的**回退** |
| `watchTool` | 恒为 `'flow_watch'` |
| `enabled`（仅 `flow_start`） | v0.7：内建 supervision 是否已在这个 run 上开启；`true` 时不要再挂 `proactive_set` |
| `scheduler`（可选） | `run.json.supervision` 的只读快照（`enabled / wakerSessionId / lastWokeAt / nextDueAt / wakes / failures / reason`）；未开启为 null |
| `hint`（仅 `flow_start`） | 一句话：已开启时说明「不需要挂闹钟，醒来调 `flow_watch`」；未开启才给 `proactive_set` 回退步骤 |

v0.7 的推荐路径是**内建 supervision**：runtime 的唯一调度器轮询到点后唤醒发起会话，
主 agent 醒来仍调 `flow_watch`；`proactive_set` 只在 `enabled=false` 时作为回退。详见 §18。

### 15.6 `flow_watch` 的边界与数据来源

- 数据：`readRunDetail`（run.json + 节点/attempt 索引）+ `readAllEvents`（全量事件）+ `readFlow`（模板），
  然后调用 `auditWorkflow({ flow, events, run, now, stallMs, nodeTimeoutMs, maxRejectsPerEdge })`
  （`src/audit.js`，见 §14；阈值默认 10 分钟 / 20 分钟 / 3 次，可由 `createFlowTools` 注入覆盖）。
- 输出：审计结果**原样**返回（`verdict / status / headline / progress / plan / currentNode / rejects /
  anomalies / quality / tokens / idleMs / recommended` 等），再附 `supervision`。
- **只报告，不自动修复、不自动停止**：是否 `flow_stop`、是否通知主人、是否继续等，由模型按 verdict 决定。
- 审计字段形状由 `audit.js` 决定，工具的 `output.schema` 对它们用宽松声明（`oneOf` 覆盖 JSON 值类型），
  避免实现形状差异被注册表的逐值校验拒绝；工具出口统一做 lossless 收口（无 `undefined` / `NaN` / `Date`）。
- `src/audit.js` 用**动态 `import()`** 加载：审计模块尚未落地时只让 `flow_watch` 返回可操作失败，
  不影响插件安装、面板与其它三个工具；测试可注入 `auditWorkflow` 桩。

### 15.7 失败形状与并发

- 成功：`{ ok: true, ... }`；失败：`{ ok: false, error, hint, retryable }`，**不抛异常**（取消时也返回失败值）。
- 失败分流：流程不存在 404 → hint 指向 `flow_list`；流程不合法 → 在**建 run 之前**由
  `validateFlowForRun` 挡下；已有 run 在跑 → 409（`engine.active` 提前挡一次，跨实例由引擎的模块级锁兜底）；
  `flow_stop` 的目标不在运行中 → hint 明确写「这个 run 不在运行中」。
- 并发按 run 不设上限（v0.7）：不同 runId 可以同时跑；`flow_start` 只会在**同一个 runId
  已在跑**时失败（409），不会因为别的 run 在跑而拒绝。

### 15.8 注册与兼容

- `src/index.js` 只在 `tools` 服务可用时注册：
  `const toolsSvc = (typeof ctx.get === 'function' && ctx.get('tools')) || ctx.tools`；
  拿不到就 `log('info', ...)` 说明并跳过——旧 profile / 测试环境不能因为缺工具注册表而装不上。
- 注册走 `ctx.effect(() => { const disposers = tools.map(t => toolsSvc.register(t)); return () => disposers.reverse().forEach(d => d()) }, 'flow-studio: 注册模型工具')`，
  卸载 / HMR 时逆序撤销，不留孤儿工具。
- 复用既有 `createRun` / `engine` / `dir` / `runsRoot`，不复制第二份建 run / 开跑逻辑；
  工具层不引入任何新依赖，也不 import dsh 包。

## 16 流程收件箱与节点会话复用

流程不只是一次性的单向执行链：它可以**接收外部发给它的消息**，消息从需求分析节点（或流程定义的某个
开始节点）往下流。为了让「同一节点的后续消息」不会被拆成许多新会话，执行引擎从 v1.6 起采用
**一个节点一个会话**；每个节点会话都可以通过 `flow_reply` 把结论回给消息来源。

### 16.1 run 目录新增文件

| 文件 | 写入方式 | 内容 |
|---|---|---|
| `runs/<runId>/sessions.json` | 原子整写（临时文件 + rename，0600） | `{ "<nodeId>": { "sessionId": "…", "createdAt": "…", "lastUsedAt": "…" } }`；坏文件按空表处理，不抛错 |
| `runs/<runId>/messages.jsonl` | JSONL 追加写（0600） | 每条一行：入站记录（`direction:"in"`）、出站记录（`direction:"out"`）或状态补丁（`{id,status}`） |
| `run.json.input` | 随 run.json 原子写 | 可选：`{ messages: [{ id, from, text, at, targetNodeId? }] }`，run 还没开始就被投递进来的消息（最多 20 条） |
| `run.json.inbox` | 随 run.json 原子写 | 可选：`{ reply: { kind, sessionId?, url?, tokenEnv? }, updatedAt }`，run 级默认回复目标 |

`messages.jsonl` 的读取会把「完整记录 + 状态补丁」按 `id` 合并，按入站/出站原始 `ts` 升序返回；
坏行跳过并计入 `skipped`，不让一行坏数据拖垮整个收件箱。

### 16.2 一个节点一个会话（引擎侧规则）

1. **首次激活**：默认 `ctx.agents.create({ sessionId: nodeSessionId(runId, node.id, attempt),
   meta:{ cwd, agentPreset? }, agentOptions })`，建出**顶层会话**；绝不传
   `parentAgent` / `meta.parentSession` / `meta.origin` / `delegationDepth`。拿到句柄后把
   `{ sessionId, createdAt, lastUsedAt }` 写进 `sessions.json`。没有 `ctx.agents.create` 的旧宿主
   才退回 `ctx.subagents.startActivation({ provider:'spawn', delivery:'caller', … })`
   （`sessionMode:'legacy-subagent'`）。
2. **二次激活**（同一节点被打回重跑、或同一 run 里再次到达该节点）：
   - `sessions.json` 命中该节点 → **绝不新起会话**；
   - 先 `ctx.agents.get(sessionId)`：拿到活的 Agent 就 `agent.followup(prompt)` 注入本轮提示词；
   - 拿不到（冷会话 / 已被压缩过的会话）→ `ctx.agents.resume({ resumeSessionId })` 得到
     `{ agent }`，再 `agent.followup(prompt)`；`resume` 会恢复会话状态（包括压缩后的上下文摘要），
     所以「被压缩过」不等于「换一个会话」；
   - 注入后 `await agent.whenIdle()`，从该会话**最后一条 assistant 消息**里解析与
     `outputSchema` 相同结构的 JSON；
   - 解析失败按既有「结构化输出不合格」路径收口：`node/end failed` + 校验错误，
     不静默吞、不回退成新会话。
3. **生命周期**：节点结束时**不 dispose**。句柄按 nodeId 存在 run 级 Map / Set 里，
   只在 run 进入终态（`done` / `failed` / `aborted`）或 `stop` 收尾时统一 `dispose()`；
   `dispose()` **只关闭会话句柄，不删除持久化日志**，会话仍可从列表打开 / `resume`（§16.2.1）。
   中途失败也不提前释放——失败节点可能还要被二次激活。
4. **降级**：没有 `ctx.agents` 服务（测试台 / 纯注入环境）时，退化为「每次新会话」，并记一条
   `warn` 日志；既有测试与桩引擎路径不受影响。
5. **事件归属**：复用会话时把 `sessionBindings` 的 `attemptId / traceId` 重挂到新的 attempt，
   避免 `model/call`、`agent/message`、成员事件被记到上一轮。

### 16.2.1 顶层会话的实测口径（v0.7 T2）

- **判据看 session header，不看 `roots()`**：`agents.create` 建出的会话 header 没有
  `parentSession` / `origin`，`delegationDepth: 0` → 顶层，Web 侧栏可见；子 agent 会话带
  `parentSession` / `origin:'subagent'` / `delegationDepth:1`。`ctx.agents.roots()` 在 `resume`
  之后也会把 agent 当 root，但持久化血缘不变，**不能用来判断是否顶层**。
- **会话列表接口**是 typert RPC `POST /api/session/list`（`GET /api/sessions` 是 404）。
  子 agent 会话 API 列表里也有，只是 Web 客户端按 `origin==='subagent'` 过滤掉。
- **`dispose()` 不删日志**：只从内存 store 移除并关持久化句柄；会话仍在列表
  （`agentAvailable:false`）、磁盘文件仍在、进程重启后仍可 `resume`。
- **`blank:true` 的会话在 Web 侧栏不可见**：只 `create` 不跑 turn 的会话 API 有、UI 看不到。
  节点会话一定会跑 turn，不受影响；任何「建了不跑」的路径都不能指望它在侧栏可见。
- `nodeSessionId(runId, nodeId, attempt)` = `<runId>--<nodeId>` 的 slug（只含
  `[A-Za-z0-9._-]`，总长 ≤96）；同一 `(runId,nodeId)` 的不同 attempt **复用同一个 id**；
  slug 有损时追加 `-` + 8 位内容哈希。

### 16.3 收件箱事件

新增两种 **run 级** 事件（不要求 `nodeId + attemptId`，因为消息可能在任何节点启动前到达）：

| kind | data 字段（白名单） | 上限 / 归一化 |
|---|---|---|
| `message/in` | `id`、`from`、`text`、`targetNodeId?`、`replyKind?` | `from` ≤200 字符；`text` 按码点截断到 2000；`targetNodeId` 必须是合法节点 id；`replyKind` ∈ session / http / none |
| `message/out` | `id`、`inReplyTo?`、`text`、`nodeId?`、`delivery` | `text` 按码点截断到 2000；`delivery` ∈ session / http / local |

`EVENT_KINDS`（05 §2 的 17 种基础契约）保持冻结；收件箱事件单独导出为 `INBOX_EVENT_KINDS`，
校验器接受两者的并集。HTTP 入口的正文上限是 4000 字符，落事件时再截到 2000。

### 16.4 消息路由表（`POST /api/flow-studio/runs/<runId>/messages`）

请求体：`{ from, text, nodeId?, reply? }`（`from` ≤200、`text` ≤4000 必填）。

目标节点解析顺序：

1. 显式 `nodeId` —— 必须是阶段节点，否则 **400**；
2. run 正在跑 —— `run.json.live.currentNodeId`；
3. 否则（pending）—— 入口节点：开始节点沿 `next` 走到的第一个阶段节点。

| mode | 条件 | 行为 |
|---|---|---|
| `injected` | 目标节点已有会话，且 `agents.get(sessionId)` 返回活 Agent | 立即 `agent.followup(...)` 注入；消息记录标 `injected` |
| `resumed` | 目标节点已有会话，但 `agents.get` 拿不到（冷 / 被压缩） | `agents.resume({ resumeSessionId })` 后 `followup`；消息记录标 `resumed` |
| `started` | 目标节点没有会话，且 run 还没开始（`status=pending`、`started=false`） | 写进 `run.json.input.messages`，`engine.start` 时作为入口节点提示词的一部分；消息记录保持 `pending`，节点启动时转 `delivered` |
| `queued` | 目标节点没有会话，且 run 正在跑 | 消息入队（`messages.jsonl` 状态 `pending`），引擎推进到该节点时并入提示词并标 `delivered` |

终态 run（done / failed / aborted）且没有会话 → **409**，不再接收消息。
没有 `ctx.agents` 服务时不能注入：pending 的 run 走 `started`，运行中的 run 走 `queued`，并记 `warn`。

返回：`{ ok: true, messageId, targetNodeId, mode, sessionId? }`。

### 16.5 提示词里的「外部消息」段

引擎在构造每个节点提示词时读取 `messages.jsonl`（并与 `run.json.input.messages` 按 id 去重合并），
分成两段拼进 `## 外部消息`：

- **fresh**：目标就是本节点、状态仍为 `pending` 的消息（最多 5 条）；
- **prior**：之前已投递过（`injected` / `resumed` / `delivered`）的消息，**入口节点收到的消息会继续出现
  在后续每个阶段节点里**（最多 5 条）。

有界口径：最多 5 条、每条 ≤1200 字，行格式 `- [ts · from]（来自流程收件箱 · …）正文`。
本节点要处理的 fresh 消息在拼完提示词后**全部标记 `delivered`**（即使只展示了前 5 条，其余也算已消费）；
提示词总预算仍是 8000 字，超限时「输出格式」段硬保留。

### 16.6 返回消息：回复目标优先级

`flow_reply({ text, inReplyTo? })` 先反查 `exec.agent.session.id` 是哪个 run / 节点的会话
（引擎内存索引 `sessionId → {runId,nodeId}`，再退回最近 20 个 run 的 `sessions.json`）；
查不到 → `{ ok:false, hint:'这个会话不属于任何流程 run' }`。

回复目标优先级（高 → 低）：

1. **消息级 `reply`**：`inReplyTo` 指向的那条入站消息自己的 `reply` 配置；
2. **run 级 `inbox.reply`**：`POST /runs/<runId>/inbox` 动态写入（运行中可改）；
3. **未配置 / `kind:'none'`**：只写 `message/out` 事件，`delivery:'local'`，返回 `ok:true` 并在 `hint`
   里说明「没有外部回复通道，已记录在运行日志」。

| kind | 行为 |
|---|---|
| `session` | `agents.get(sessionId)`（活）或 `agents.resume`（冷）后 `followup`；正文前加来源标记 `[flow:<流程名> · <节点标题>]` |
| `http` | `POST url`，body `{runId, nodeId, messageId, text}`；`tokenEnv` 指定的环境变量作为 `Authorization: Bearer`；超时 10s；失败不抛异常 |
| `none` | 只记事件 |

**任何一条回复**都会写 `message/out` 事件与 `messages.jsonl` 出站记录。`GET /runs/<runId>/messages?limit=`
把 in/out 合并按时间列出；`POST /runs/<runId>/inbox` 只能写 `{ reply }`，`tokenEnv` 只存环境变量名，
令牌值永不落盘。

### 16.7 会话冷 / 被压缩时的复用边界

- 冷会话（进程重启、会话被回收）与**被压缩过的会话**都走 `agents.resume({ resumeSessionId })`：
  恢复的是同一个会话（含压缩摘要），会产生新的 turn，**不会**新建第二个会话。
- `resume` 拿不到 Agent、或目标 Agent 没有 `followup` → 该节点按失败收口（503 语义），
  **不会**悄悄换成新会话——「一个节点一个会话」是硬约束，宁可失败也不静默分叉。
- 复用会话的 assistant 输出必须能解析成 JSON 对象；解析失败 / 空输出 = 结构化输出不合格，
  走与首次激活相同的失败路径。
- 复用会话时 `whenIdle()` 决定「这一轮结束」；如果宿主没有 `whenIdle`，引擎只能读到 followup 之后
  已到达的事件，读不到就按解析失败处理（不伪造结果）。
- run 结束统一 dispose 会话句柄（**不删日志、不删会话文件**）；进程崩溃残留的会话由宿主自己的
  会话回收负责（本插件不做跨进程清理）。

### 16.8 安全与兼容

- 外部文本一律按码点截断：请求体 4000、事件 2000、提示词单条 1200、来源 200；消息文件 8 MiB、
  sessions.json 512 KiB 为最后闸门。
- URL 只允许 `http:` / `https:`；`tokenEnv` 只接受合法环境变量名，值只从 `process.env` 读取。
- 所有路径都是 run 目录内的固定相对文件名（`messages.jsonl`、`sessions.json`），
  不拼外部输入；runId 继续走 `checkRunId()`。
- 模型工具 `flow_send_message` / `flow_reply` 只在 agents 服务可用时注册；
  它们与 HTTP 路由共用 `src/inbox.js` 的同一套内部函数，不自己拼 HTTP。

## 17 外部 executor（v0.7）

> 对应 07 册 R6。实现：`src/executor.js`（归一化 / argv / JSONL / 子进程）+ `src/engine.js`
> （`_executorSpecOf` / `_writeExecutorSchema` / `_runExternalNode`）；测试：
> `test/executor.test.mjs`、`test/engine.test.mjs` 的「engine v0.7 · 外部 executor（R6）」。

### 17.1 保存宽松、启动严格

v0.7 把「编辑期」和「开跑」拆成两个口径：

| 动作 | 口径 | 结果 |
|---|---|---|
| `POST /flows`、`PUT /flows/<id>` | **宽松**：`validation.errors` 不拦保存；仍会 400 的只有形状/协议错误（body 不是 JSON 对象、PUT 缺 body、`version` 不是正整数） | 能解析成对象的请求 → 200 `{ ok, flow, validation }`；`validation.errors` 非空也照存、照推进 `version`；409 只留给 PUT 的乐观锁冲突 |
| `POST /runs` | 只校验 `flowId` 存在 | 建出 `pending` run；不在这里拦内容 |
| `flow_start` / `POST /runs/<id>/start` | **严格**：`validateFlowForRun(flow)`，errors 一律 400 | 不建 run / 不进入执行；错误文案带第一条具体原因 |

为什么：客户端画布是 600ms 防抖自动保存，用户拖一个还没填任务的空节点、或新建空流程，
`validateFlow` 必然报 error；保存侧把它当 400 会让每一次中间态都存不进去。真正该严的是开跑。
因此下面这些配置**可以保存、但开不了跑**：

- `executor:'custom'` 且 `executorCommand` 为空 → 启动 400；
- `executor:'codex' | 'custom'` 且 `mode:'team'` → 启动 400。

（未知 `executor` 在保存 / 读回时已被 `normalizeFlow` 收敛成 `dsh`；执行侧 `normalizeExecutor`
仍会对绕过保存的手改流程抛 `EXECUTOR_INVALID`。）

证据：`src/index.js` `rejectMalformedFlowBody()`（保存侧形状门槛）、`src/engine.js`
`validateFlowForRun()`（含 executor 两条规则）、`test/host.test.mjs` 的「保存门禁」组、
`test/model.test.mjs` 的「executor 校验」组。

### 17.2 `node.executor` 三档

| 值 | 必填 | 运行时行为 | 归一化结果 |
|---|---|---|---|
| `dsh`（默认） | — | 走节点主管会话（`ctx.agents.create` / 复用会话，见 §16） | `{ kind:'dsh' }` |
| `codex` | —（`executorCommand` 可选） | 起 `codex exec` 外部进程，逐行读 `--json` | `{ kind:'codex', command, args:['exec','--json'], model }` |
| `custom` | `executorCommand` 非空 | `sh -c <模板>` 起外部进程 | `{ kind:'custom', command, args:[], model }` |

- `normalizeFlow` 把未知 `executor` 收敛成 `dsh`；`executorCommand` 按 2000 字符截断。
- `validateFlow` 在**启动侧**（`validateFlowForRun`）检查：custom 必须有命令模板；外部
  executor 只允许 `mode:'single'`（`team` 需要引擎观察成员会话，外部进程做不到）。
- 执行时 `normalizeExecutor(node)` 再校验一次；非法组合抛 `EXECUTOR_INVALID`（中文原因），
  `_executorSpecOf()` 把它转成 `StructuredOutputError`，走节点既有的「结构不合格」失败路径。
- `codex` 的 `executorCommand` 只作为**可执行文件路径覆盖**（例如 `/path/to/codex`），
  不是完整命令模板；custom 才是模板。

### 17.3 codex 的真实命令行

`buildCodexArgs()` 按 `codex exec --help`（0.166.0）拼 argv，顺序固定：

```sh
codex exec --json --output-schema <schema.json> -C <cwd> --skip-git-repo-check \
  -s workspace-write [-m <model>] <prompt>
```

| 参数 | 值 |
|---|---|
| `--json` | 强制 stdout 为 JSONL |
| `--output-schema` | 引擎每次 attempt 写出的 schema 文件（见 §17.5） |
| `-C` | `cwd`：worktree 开着用 `worktree.path`，否则 `workspace.path` |
| `--skip-git-repo-check` | 允许在非 git 仓库工作区跑 |
| `-s` | 默认 `workspace-write`；只接受 `read-only / workspace-write / danger-full-access` |
| `-m` | 仅当 `node.model` 非空时传 |
| `<prompt>` | 位置参数，必须在所有选项最后 |

- 可执行名默认 `codex`；`node.executorCommand` 非空时替换它（只换路径）。
- 不联网、不真跑 codex 也能测：`test/executor.test.mjs` 全部用假 `spawn` 或真 `node` 子进程桩，
  `test/engine.test.mjs` 用 `node -e` / `sh -c` 桩命令。

### 17.4 custom 的命令模板

- 执行方式固定 `sh -c <script>`，不经过引擎的 argv 解析。
- `{prompt}` / `{schema}` / `{cwd}` 三个占位符会被替换，并做 POSIX shell 单引号转义；
- 三个占位符都没有时，把 prompt 作为最后一个参数追加（同样转义）；
- 无论模板用不用 `{schema}`，引擎都会先生成 schema 文件（见 §17.5）并传路径。

stdout 的消费与 codex 同一套：逐行 JSONL → log / usage / final；如果 custom 只打印一段
非 JSONL 的文本（例如整段 JSON），关闭时用整段 stdout 作为 text 回退，再按 §17.5 解析结构。

### 17.5 JSONL → 节点日志 / 用量

| executor 输出 | `parseCodexLine` | 引擎写入 |
|---|---|---|
| `{"type":"item.completed","item":{"type":"agent_message","text":"…"}}` 或 `{"type":"agent_message","text":"…"}` | `final` | 不单独写事件；最后一条作为最终文本，交给 `parseAssistantStructured` |
| `turn.completed` 带 `usage`，或 `{"type":"usage",…}` | `usage` | 仅当 usage 非空：写一条 `model/call` |
| 非 JSON 行、未知但带可读文本的事件 | `log` | `agent/message`（`role:'assistant'`） |
| `command_execution` / `reasoning` / `file_change` / `mcp_tool_call` / `web_search` | `log`（带 `itemType`） | 同上 |
| `error` / `turn.failed` / `item.failed` | `log`（`level:'error'`） | 同上（不把失败误当成功） |
| stderr（只保留尾部 ≤2000 字符） | `stderr` | 关闭时非空则写一条节点日志 |

具体字段：

- **`agent/message`**：`role:'assistant'`、`text` 按码点截到 ≤2000、`truncated` 布尔、
  `provider:'codex'|'custom'`、有 model 时带 `model`。每个节点 attempt 最多写 200 条
  （`LOG_LIMIT`），超出的过程日志丢弃，避免一条刷屏命令撑爆事件数组。
- **`model/call`**：`provider` 同上、`model` = 节点 model 或 `'unknown'`、
  `callId = executor:<nodeId>:<attemptId>`（≤128）。同一 attempt 重试用**同一个 callId**，
  聚合层按「后到整条替换」处理，不会重复计 token。
- **四桶归一化**：`mapHostUsage()` 输出 `{ input, cacheRead, cacheWrite, output }`，缺桶补 0；
  `reasoning` 仅在 `≤ output` 时附带。codex 的 `usage`（`input_tokens/output_tokens/total_tokens`）
  先归一成 `{input,output,total}`，因此外部 executor 通常 `cacheRead=cacheWrite=0`。
- **结构化输出**：最终文本先试整段 JSON，再试 ```json 围栏，最后取首个 `{` 到末个 `}`；
  只有普通对象算数。解析不出 → `StructuredOutputError`（不伪造 pass）。

**schema 文件**（每次 attempt 一个）：

| 项 | 值 |
|---|---|
| 路径 | `<runsRoot>/<runId>/executors/<attemptId>.schema.json` |
| 目录 / 文件权限 | 目录 0700、文件 0600 |
| 内容 | `ENGINE_OUTPUT_SCHEMA`（与 dsh 路径同一份节点输出 schema，§4.3） |
| 写入时机 | 起外部进程之前；写失败按普通节点错误处理 |

`runsRoot` 默认 `$DSH_HOME/flow-studio/runs`（`runstore.runsDir()`）。

**没有节点会话**：外部 executor 节点不调 `agents.create`、不写 `sessions.json`、
不登记 `sessionIndex`。因此收件箱对它的可达方式只有 `queued`（消息随下一次节点提示词消费），
`injected / resumed` 不适用；外部进程里也无法调用 `flow_reply`。

### 17.6 失败语义

节点级重试沿用 §9：默认重试 1 次（`FLOW_STUDIO_NODE_RETRIES`，0–5），**不新增 `attemptId`**；
重试用尽才写 `node/end{status:'failed'}` 与 `run/end{status:'failed'}`。

| 情况 | 引擎抛出 / 收口 | 是否重试 |
|---|---|---|
| 配置非法（未知 executor / custom 缺命令 / codex+team） | `StructuredOutputError`，文案「executor 配置不合法：…」 | 是 |
| 子进程起不来（spawn 失败） | `Error`「无法启动外部 executor（codex）：…」 | 是 |
| 非 0 退出 | `Error`「外部 executor（codex）非 0 退出（N）：<stderr 尾部>」 | 是 |
| 超过 `nodeTimeoutMs`（默认 20 分钟） | `NodeTimeoutError`（`extra.timeout=true`） | 是 |
| `stop` / run 墙钟中止 | `AbortError`；run 收成 `aborted`（不是 failed） | 否 |
| structured 为空 / 解析失败 | `StructuredOutputError`，文案带 stderr 尾 | 是 |
| schema 写盘失败 | 普通节点错误（按上表重试） | 是 |

已经写入的 `agent/message` / `model/call` 保留；失败不会补写假的成功事件。

### 17.7 为什么只允许 `mode:'single'`

`team` 模式下引擎要靠 `parentSession === leadSessionId` 把成员会话绑成 `memberId`、按成员归属
用量与事件（§4.2 / §8）。外部进程没有 dsh 会话，引擎观察不到成员，也无法把事件挂到成员上；
所以这是**契约级限制**，不是暂未实现：

- 保存侧：`validateFlow` 报 error（但保存仍 200，见 §17.1）；
- 启动侧：`validateFlowForRun` 400；
- 执行侧：`normalizeExecutor` 再抛一次 `EXECUTOR_INVALID`（防手改流程 / 绕过保存）。

要同时用外部 agent 和团队，拆成两个节点：外部 executor 节点做单 agent 的活，team 节点用 dsh 会话。

### 17.8 可复核证据

```sh
node test/executor.test.mjs     # 13 组 / 81 条断言
node test/engine.test.mjs       # 61 组 / 493 条断言（含 v0.7 外部 executor 5 组）
node test/model.test.mjs        # 17 组（executor 校验 1 组）
```

对应代码：`src/executor.js` 的 `normalizeExecutor` / `buildCodexArgs` / `parseCodexLine` /
`runExternalExecutor`；`src/engine.js` 的 `_executorSpecOf` / `_writeExecutorSchema` /
`_runExternalNode`；`src/model.js` 的 `EXECUTOR` / `validateFlow`。

## 18 内建 supervision（v0.7）

> 对应 07 册 R7。实现：`src/supervise.js`（纯调度）+ `src/runtime.js`（审计 / 唤醒 / 持久化接线）
> + `src/tools.js` / `src/index.js`（两个入口）；测试：`test/supervise.test.mjs`、
> `test/runtime.test.mjs`、`test/tools.test.mjs`、`test/host.test.mjs`。

### 18.1 默认策略

| run 从哪来 | supervision 默认 | 怎么开 |
|---|---|---|
| `flow_start` 模型工具 | **开启**：启动成功后自动 `enableSupervision(runId,{ enabled:true, wakerSessionId: 发起会话 })` | 自动；登记失败只 warn，不拖垮启动 |
| HTTP `POST /runs` + `POST /runs/<id>/start` | **关闭** | `POST /runs/<id>/supervision` 或 `flow_supervise` |
| 进程重启后的存量 run | 只恢复「`enabled:true` 且 `wakerSessionId` 非空」的 run | 缺 waker 的 run 跳过（避免连续 3 次失败刷噪音），之后可手动开 |

`flow_start` 返回 `supervision.enabled=true` 时，提示语是「内置调度已开启，无需再挂
proactive_set 闹钟」；`enabled=false`（引擎没有 `enableSupervision` 或登记失败）才回退到
0.5.0 的 `alarmPrompt` / `nextCheckSeconds` 手动闹钟。**推荐路径是内建调度**，旧字段保留只为兼容。

### 18.2 调度归属与节奏

- 一个 `createRuntime()` 只起**一个** `SupervisionScheduler`、一个 `setInterval`；
  默认 **15s** 一跳（`supervisionIntervalMs` 优先，其次 `intervalMs`），定时器 `.unref()`，
  不吊住事件循环。
- runtime 创建时就 `supervision.start()`；`runtime.dispose()` 时 `stop()`。
  每个 run 不单独起定时器。
- 分工：`supervise.js` 只决定「该不该唤醒 / 下次何时 / 失败几次降级」；
  `evaluate`（runtime 调 `auditWorkflow`）、`wake`（`agents.get` / `resume` + `followup`）、
  `load` / `save`（run.json）全部由 runtime 注入。supervise 不 import dsh、不直接读写 run.json。
- `tick()` 有重入保护：上一轮未结束时，新一轮直接返回 `{ skipped:true }`。

### 18.3 `planWake` 的间隔规则

| 输入 | `reason` | 间隔 | `nextDueAt` |
|---|---|---|---|
| verdict 或 `run.status` 是 `done / failed / aborted` | `terminal` | — | `null`（停止调度） |
| verdict `pending` | `pending` | 30s | 基准 + 30s |
| verdict `healthy` | `healthy` | 180s | 基准 + 180s |
| verdict `stalled / looping / deviating / no-progress` | `anomaly` | 60s | 基准 + 60s |
| verdict 缺失 / 未知 | `unknown-verdict` | 60s（异常侧保守） | 基准 + 60s |

- 基准时间：`lastWokeAt ?? run.startedAt ?? now`；坏日期不抛错，按 `now` 处理。
- `shouldWake = (run.status === 'running' || 'pending') && now >= nextDueAt`；
  status 缺失 / 未知一律不唤醒（宁可少叫一次）。
- 对外时间字段一律 ISO-8601 字符串。

### 18.4 幂等与重启恢复

- 每次 tick 先 `load(runId)` 读 `run.json.supervision`，与内存状态合并；
  同一 `nextDueAt` 只唤醒一次。
- 到点唤醒后**立刻推进** `nextDueAt`（成功、失败都推进），以本次唤醒时间为新基准，
  避免同一个 due 反复叫。
- 写盘失败（`save` 抛错）只 warn；内存状态仍推进，保证本轮不会重复唤醒。
- 重启恢复：`runtime.supervisionReady` 扫描 `listRuns(limit:100)` 中 `status ∈ {pending,running}`
  且 `supervision.enabled === true`、`wakerSessionId` 非空的 run，`register()` 登记；
  **不立刻唤醒**，第一次唤醒仍由 `nextDueAt` 决定。
- 多进程/多实例：tick 时若落盘 `lastWokeAt` 比内存新，以落盘为准，避免重复唤醒；
  这不是分布式锁，跨进程的 run 写者互斥仍由 run 目录的 `lock.json` 租约负责。
- 显式 `register()` 是「重新启用」动作：对已写 `enabled:false` 的 run 再次登记，
  会从 0 开始计数（旧 `wake-failed` 结论作废）。

### 18.5 连续 3 次失败降级

- `wake` 返回 `false` 或抛错 → `failures += 1`；成功一次 → `failures = 0`。
- `failures >= 3` → `enabled:false`、`reason:'wake-failed: <原因>'`、`unregister(runId)`，
  并写一条 warn 级宿主日志；**不新增 runlog 事件**，状态只在 `run.json.supervision` 与日志里。
- 降级后不再尝试；要恢复由 `flow_supervise` / `POST /runs/<id>/supervision` 重新开启。
- 终态（done / failed / aborted）：run 收尾时 runtime 立即 `unregister` 并落盘
  `{ enabled:false, reason:'terminal' }`；调度器 tick 里也会做同样收口。

### 18.6 唤醒动作

到点后 runtime 的 `wakeRun(runId,{ wakerSessionId })`：

1. 取 `ctx.get('agents')`；不可用 → 抛错（计一次失败）；
2. `wakerSessionId` 为空 → 抛错（计一次失败）；
3. `agents.get(wakerSessionId)` 拿活 Agent；拿不到就 `agents.resume({ resumeSessionId })`；
4. `agent.followup(buildFollowupPayload({ text: supervisionWakePrompt(runId), … }))`。

提示词固定包含：`runId`、要求调用 `flow_watch`、明确「这是内置调度唤醒，不需要再手动挂
proactive_set 闹钟」、以及 healthy 就结束本轮 / 异常或跑完才通知主人。实现见
`runtime.supervisionWakePrompt()`。

### 18.7 两个入口

| 入口 | 入参 | 行为 |
|---|---|---|
| `flow_supervise`（模型工具） | `{ runId, enabled }`（都必填） | `enabled:true` 时用**当前会话 id** 作 `wakerSessionId`；`false` 时 unregister + 落盘 `disabled-by-caller`；返回 `{ ok, runId, enabled, supervision, scheduler }` |
| `POST /runs/<runId>/supervision` | `{ enabled: boolean, wakerSessionId?: string }` | 与 `flow_supervise` 共用 `runtime.enableSupervision()`；`enabled:true` 对已收尾 run → 400；省略 `wakerSessionId` 会登记一个叫不醒的 run，建议显式传 |
| `GET /runs/<runId>/supervision` | — | 返回 `{ supervision: run.json.supervision, scheduler: scheduler.status(runId) }` |

- `scheduler.status()` 字段：`{ enabled, nextDueAt, wakes, failures, lastReason }`。
- 客户端**只读展示**：运行详情与 `flow_watch` 的 `supervision.scheduler` 都读 run.json；
  开关由工具 / HTTP 负责。

### 18.8 `run.json.supervision` 字段

| 字段 | 类型 | 语义 |
|---|---|---|
| `enabled` | boolean | 是否仍在调度；缺省按 `true` 读，但重启恢复只认显式 `true` |
| `wakerSessionId` | string \| null | 到点唤醒哪个会话（发起会话 id）；缺省无法唤醒 |
| `lastWokeAt` | ISO string \| null | 上次唤醒时间（成功或失败都推进） |
| `nextDueAt` | ISO string \| null | 下次到期时间；`null` = 已停 |
| `wakes` | 非负整数 | 累计成功唤醒次数 |
| `failures` | 非负整数 | 连续失败次数；成功清零，达到 3 降级 |
| `reason` | string \| null | 最近一次判定 / 停用原因：`healthy` / `anomaly` / `pending` / `terminal` / `disabled-by-caller` / `wake-failed: …` 等 |

### 18.9 可复核证据

```sh
node test/supervise.test.mjs    # 27 组 / 194 条断言
node test/runtime.test.mjs      # 16 组 / 152 条断言
node test/tools.test.mjs        # 35 组 / 336 条断言（含 flow_start 自动开启、flow_supervise）
node test/host.test.mjs         # 40 组（含 POST /runs/<id>/supervision）
```

关键用例：`planWake` 的终态 / pending / healthy / 异常 / 未知 verdict 五档，到点只唤醒一次、
连续 3 次失败降级、成功清零、重启恢复计数与 `nextDueAt`、终态自动摘除、两进程落盘较新者优先、
tick 重入保护、`flow_start` 自动开启与失败回退、HTTP 启用/禁用。
