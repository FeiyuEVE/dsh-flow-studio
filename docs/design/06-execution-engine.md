# 06 · 执行引擎（v0.4）

> 本册定义「图怎么变成真跑」：run 生命周期、主循环、提示词、结构化产物、事件映射、用量采集、
> 取消与失败、接口与客户端控制、以及怎么在没有真模型的情况下做 Docker 测试。
> 依赖 05 的事件契约（本册只规定**谁在什么时候写哪条事件**，不重新定义事件格式）。

## 1 目标与非目标

**要做**：一次 run 从开始节点沿 `next` 边推进；每个阶段节点真的起一个子 agent 会话（`spawn`），
用到该节点配置的角色/任务/产物/skill；节点返回结构化判定；判定 `reject` 时沿 `reject` 边回退、
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
- 引擎同一时刻只允许一个 run 在跑（全局锁）；已有运行中 run 时 `start` 返回 409。

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
2. `ctx.subagents.startActivation({ provider:'spawn', label: '<runId>/<nodeId>#<attempt>', delivery:'caller', signal, request:{ prompt, parent: 当前会话, outputSchema } })`；
3. `await activation.result` → `structured` 即结构化产物；`dispose()` 收尾（无论成功失败）。

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

- 订阅 `session/event`（`{ global: true }`），只关心本 run 已知的会话 id（引擎在 spawn 后把 `sessionId → {nodeId, attemptId, memberId}` 登记进内存映射）。
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

- 引擎做成**依赖注入**：`createEngine({ activate, now, readUsage, signal })`。`activate` 是唯一的模型入口，测试传桩函数即可。
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
`start` 前调用 `validateFlow`，**errors 一律 400**（不允许带着断头路/成环/多出边开跑）。
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
`node.model` 必须真正传给子 agent：`request.agentOptions = { model: node.model }`（spawn provider 支持）；
宿主不支持时启动前报错，不允许「界面能填、实际不生效」。

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
     → engine.start(runId, { parent: exec.agent })
     → request.parent = 当前会话的 Agent，request.cwd 省略
     → 子 agent 继承本会话的工作区（不需要也不应该再选目录）

② proactive_set
     after_seconds = supervision.nextCheckSeconds
     prompt        = supervision.alarmPrompt（完整提示词，含 runId / flow_watch / proactive_reclaim）

③ 每次闹钟醒来 → flow_watch（runId）
     verdict 正常（healthy / running 类）→ proactive_reclaim 安静结束，不打扰主人
     异常（stalled / looping / deviating / no-progress）或已跑完（done / failed / aborted）
       → 把结论与需要决策的点通知主人
```

工具描述（`description`）里必须写清这三步——那是模型唯一会读到的使用说明。

### 15.2 工具清单

| 工具 | 读写 | 入参 | 出参（成功） |
|---|---|---|---|
| `flow_list` | 只读 | `{ limit?: integer }`（默认 20、上限 100） | `{ ok, flows: [{ id, name, nodeCount, edgeCount, updatedAt }] }` |
| `flow_start` | 写（exclusive） | `{ flowId?, flowName?, task?, name? }`（`flowId` / `flowName` 二选一，都不给 → 失败并提示先 `flow_list`） | `{ ok, runId, flowId, flowName, status, workspace, supervision }` |
| `flow_watch` | 只读（`isConcurrencySafe`） | `{ runId? }`（省略 = 最近一次 run） | 审计结果原样 + `{ ok, runId, flowId, supervision }` |
| `flow_stop` | 写 | `{ runId: string }`（必填） | `{ ok, runId, status }` |

命名规则：`flowId` 优先；没有 id 时按 `flowName` **精确匹配**，再退不区分大小写；同名多份 → 失败并列出候选 id
（让模型用 `flowId` 指定，而不是猜）。`task` 是用户这次要跑的任务原文，写进 `run.json.name`；显式 `name` 优先于 `task`。

### 15.3 `engine.start(runId, { parent })`：per-start 父会话

`engine.start` 增加**可选**第二参数：

```js
engine.start(runId)                    // 旧调用：行为完全不变
engine.start(runId, { parent })        // 本次 run 用 parent 覆盖父会话（Agent 对象）
```

- 优先级：`startParent`（本次覆盖）→ `this.parent` → `resolveParentFn()` → `agents.roots()` 最后一个。
  不传 / 传 `null` 时 `startParent` 为 `null`，后三段回落的既有语义**一字未改**。
- 生命周期：只在这一次 run 内有效；run 收尾（`_cleanupActive()`）清空，不影响下一次 `start`。
  非对象 `parent` 在抢 `START_LOCK` 之前以 400 拒绝，不会留下占位的运行态。
- 不新增事件 kind、不写 runlog、不改变 `run/start` 与 `run.json` 的任何字段：
  父子关系只体现在 `subagents.startActivation({ request: { parent } })` 的调用参数上。
- 并发语义不变：模块级 `START_LOCK` 仍然保证同一时刻只有一个 run（第二个 `start` → 409）。

### 15.4 工作区继承

`ctx.subagents.startActivation({ provider:'spawn', delivery:'caller', request:{ parent, cwd?, prompt, ... } })` 中：

- `request.parent` 是 **Agent 对象**（不是 id 字符串）；
- `request.cwd` 省略时**继承父 agent 的工作目录**。

所以 `flow_start` 直接把 `exec.agent`（当前会话的 Agent）作为 `request.parent` 传下去，
`request.cwd` 不传——从哪个会话启动，子 agent 就在哪个工作区里干活，无需额外选择。
返回值里的 `workspace.inheritedFrom` 是该会话 id（`exec.agent.session.id`，取不到为 `null`），
只用于向模型/用户交代「继承了谁」，不参与执行。

### 15.5 定时自审（`supervision`）

`flow_start` 与 `flow_watch` 都返回 `supervision`：

| 字段 | 语义 |
|---|---|
| `nextCheckSeconds` | 建议的审查间隔（`proactive_set` 的 `after_seconds`）。`flow_start` 默认 180；`flow_watch` 优先用审计模块给的值，钳制在 30–900；终态（done / failed / aborted）为 `null` |
| `alarmPrompt` | 完整中文提示词（≥40 字），包含 `runId`、要调 `flow_watch`、healthy 就 `proactive_reclaim` 安静结束、异常或跑完才通知主人；终态时说明「不必再挂闹钟」 |
| `watchTool` | 恒为 `'flow_watch'` |
| `hint`（仅 `flow_start`） | 一句话：用 `proactive_set` 的 `after_seconds=nextCheckSeconds` 把闹钟挂上，之后每次醒来调 `flow_watch` |

审查是**旁路**：闹钟到点后由主 agent 主动调用工具，引擎不自己轮询、不自己通知。

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
- 同一时刻只有一个 run：`flow_start` 在已有 run 运行时直接失败，不建新 run；
  提醒模型不要在流程里再起一个流程。

### 15.8 注册与兼容

- `src/index.js` 只在 `tools` 服务可用时注册：
  `const toolsSvc = (typeof ctx.get === 'function' && ctx.get('tools')) || ctx.tools`；
  拿不到就 `log('info', ...)` 说明并跳过——旧 profile / 测试环境不能因为缺工具注册表而装不上。
- 注册走 `ctx.effect(() => { const disposers = tools.map(t => toolsSvc.register(t)); return () => disposers.reverse().forEach(d => d()) }, 'flow-studio: 注册模型工具')`，
  卸载 / HMR 时逆序撤销，不留孤儿工具。
- 复用既有 `createRun` / `engine` / `dir` / `runsRoot`，不复制第二份建 run / 开跑逻辑；
  工具层不引入任何新依赖，也不 import dsh 包。
