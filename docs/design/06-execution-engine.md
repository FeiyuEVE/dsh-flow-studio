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
5. **上游产物**：最近 3 个已通过节点的 summary 与产物路径（不粘全文，给引用）；
6. **打回上下文**（仅 attempt>1）：上一轮判定、打回原因、上次 findings；
7. **输出格式**：明确要求返回 §4.3 的 JSON（`verdict` 必填、`reject` 必带 `rejectReason`），不要夹带正文产物以外的解释。

提示词长度上限 8000 字，超出按 §5 完整性优先截断（上游产物先截）。

## 7 事件映射（引擎侧必须写）

| 时机 | 事件 |
|---|---|
| run 开始 / 结束 | `run/start` / `run/end` |
| 节点开始 / 结束 | `node/start`（带 `skills[]`，这是覆盖率分母）/ `node/end` |
| 成员开始 / 结束 | `member/start`（`memberId` 必填）/ `member/end` |
| 模型调用 | `model/call`（`callId` 必填，四桶 usage） |
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
- 单节点超时默认 20 分钟（可按 `FLOW_STUDIO_NODE_TIMEOUT_MS` 覆盖）；超时 → 节点 `failed`。
- 任何异常都要落到 `run/end{status:'failed', reason}` 并把细节写进事件 `extra`，不允许静默停住。
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
