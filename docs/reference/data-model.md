# 数据模型

两类数据：**流程文件**（用户画的图）与 **run 目录**（一次运行的落盘）。两者都在 `$DSH_HOME/flow-studio/` 下，目录 0700、文件 0600；没有另外的覆盖变量。事件字段本身不在这里定义，见 [运行日志](run-log.md) 与契约正文 [design/05](../design/05-run-log.md)。

## 流程文件

一份流程就是一个 JSON：

```jsonc
{
  "schemaVersion": 1,
  "id": "flow-ab12cd34ef",
  "name": "标准研发流水线",
  "agentPreset": "",                       // 流程级默认 preset，空 = 引擎兜底 standard
  "nodes": [
    {
      "id": "n_req", "kind": "stage",        // start | stage | end
      "title": "需求分析", "x": 300, "y": 220,
      "mode": "single",                      // single | team
      "role": "资深需求分析师……",             // 角色定位
      "task": "把任务卡拆成可验收的需求条目……",  // 负责的事
      "skills": ["java-service"],            // 引用的 skill 名
      "outputs": "需求清单 R1..Rn + 风险表",   // 期望产物
      "maxRounds": 2,                        // 打回上限
      "model": "",                           // 模型覆盖，空 = 跟随宿主默认
      "agentPreset": "",                     // 节点会话 preset，空 = 继承流程/引擎，兜底 standard
      "executor": "dsh",                     // dsh（默认）| codex | custom
      "executorCommand": "",                 // custom 必填；codex 可填可执行文件路径
      "team": [{ "name": "接口实现", "role": "……", "task": "……" }]
    }
  ],
  "edges": [
    { "id": "e_1", "from": "n_req", "to": "n_plan", "kind": "next", "label": "" },
    { "id": "e_2", "from": "n_plan", "to": "n_req", "kind": "reject", "label": "方案被打回" }
  ]
}
```

节点只有三种 `kind`：`start` / `stage` / `end`；只有阶段节点有角色、任务、skill 与主从配置。连线只有两种 `kind`：`next`（正常流转）/ `reject`（打回，目标必须是上游）。

**未识别字段原样收进 `extras`**（有界：键 ≤16、单串 ≤256、总字节 ≤2048、深度 ≤3；坏输入不抛错），后续加字段不会被保存链静默丢掉。例如节点显式 `provider` 目前不是已知字段，会落在 `extras.provider`，引擎解析模型路由时同样优先使用它。

`agentPreset` 只做安全 id 校验（小写字母 / 数字 / `-` / `_`，≤64）；空 = 继承流程 / 引擎默认，最终兜底 `standard`。preset 是否真实存在由宿主 registry 在创建会话时判断（插件可注册 `digital-human` / `specialist` 等自定义 id）。

### 校验分两级

- **error（跑不起来）**：没有开始节点、有孤立节点、打回目标不在上游、阶段节点没写任务、`custom` executor 缺命令、外部 executor 配了 team……
- **warning（能存但作者大概还想改）**：没写角色、主从节点没配子 agent、走不到结束节点……

### 保存宽松、启动严格

v0.7 起：`POST /flows` / `PUT /flows/<id>` 都**不因 `validation.errors` 拒绝**（画布 600ms 防抖自动保存，半成品必须存得下），`nodes: []` / `edges: []`（用户删光节点）同样照存。保存类 400 只剩请求体形状与整份替换的完整性：请求体不是 JSON 对象；`PUT` 额外要求 body 存在、`version` 是正整数、`nodes` / `edges` 是数组（`FLOW_BODY_INCOMPLETE`，0.9.1 起；否则 `normalizeFlow` 会把流程写成空图）；主机开关关闭时含 `executor:'custom'` 的流程也 400（`CUSTOM_EXECUTOR_DISABLED`）；逐条列在 [Host 接口](host-api.md)。真正拦人的是 `POST /runs/<id>/start` 与 `flow_start` 的 `validateFlowForRun`，非法流程返回 400，不会开跑。运行前校验与引擎同一口径（成环 / 多出边 / 打回指向非阶段节点），在发请求之前就拦住。

### 并发保存

流程文件带 `version`，保存是乐观锁：版本不符返回 **409** 且磁盘零改动；客户端弹出「用我的版本覆盖 / 载入服务器版本」两条出口，不再后写静默覆盖先写。还没有多人实时编辑（看不到对方光标、没有自动合并）。

### 历史备份

0.9.1 起每次覆盖保存前，先把磁盘上的旧版本另存一份——「整份替换」不该是不可逆的；这是兜底，不是主路径（备份失败不挡保存）。布局在 `flows/` 同目录：

```text
$DSH_HOME/flow-studio/flows/
  <id>.json                      # 当前版本（原子写）
  .history/
    <id>.v<version>.json         # 覆盖前的那一版；每份流程只留最近 3 份
    deleted/
      <id>.v<version>.json       # 删除流程后从活动历史挪进来的归档
```

- 备份以 `version` 命名；同一个 `<id>` 的同一个 `version` **绝不覆盖**已有备份——删除后撤销、按新文件从 v1 重建再保存会再次走到 v1，旧证据必须留着。
- `.history/` 是目录不是流程文件：不出现在 `GET /flows` 列表里，读取 / 保存路径也不会把它当流程。
- 保留策略只作用于活动备份：每次写入后按 `version` 倒序只留最近 3 份；`deleted/` 是归档，不参与轮转（需要清理由运维手动处理）。
- `DELETE /flows/<id>` 成功删掉文件后，才把该 id 的活动历史挪进 `.history/deleted/`（归档重名时加时间戳后缀）；历史目录不存在时静默跳过，不影响删除的返回语义（文件本来就不存在仍是 `false`）。

## 流程目录（0.12）

一份流程还可以用**目录**保存，用于编辑期阅读、diff 与局部改写。目录是编辑期真源，`flows/<id>.json` 仍是运行期真源；两者**不做自动双向同步**，靠「导入生成新 id」避免两个真源互相覆盖。

```
<dir>/flow.json                 # { schemaVersion, name, description, nodeOrder: [id...], edges: [...] }
<dir>/nodes/<id>.json           # 该节点除 task 外的全部字段
<dir>/nodes/<id>.task.md        # 该节点的 task 正文（Markdown 原文）
```

- `nodeOrder` 决定节点顺序，不靠文件名排序。
- `nodes/<id>.json` **不得**含 `task`（正文在 `.task.md`，两个真相源会被判 `task-duplicated`）。
- 布局之外的任何文件 → `unknown-file`，不静默忽略（避免目录里躺着没人读的内容）。
- 编译走 `src/flowdir.js`：组装后过 `normalizeFlow` + `validateFlow`，**不另写一套结构校验**；错误带 `{code, path, field?, message}`，按文件与字段定位。
- 路径安全：`..` / 绝对路径 / 反斜杠 / symlink 越界一律拒；单文件上限 64 KiB。
- 导出目标必须不存在、为空，或本来就是目录化产物——不覆盖别人的目录。

命令行入口：`POST /flows/import-dir`、`POST /flows/<id>/export-dir`；模型工具 `flow_compile`、`flow_decompile`。决策与推导见 [0.12 流程产物目录化](../plan/0.12-流程产物目录化.md)。

## Run 落盘布局

```
$DSH_HOME/flow-studio/runs/
  <runId>/
    run.jsonl                      # run 级事件：开始 / 结束 / 状态变更（append-only）
    run.json                       # run 元数据（可变，原子写；跨进程 meta.lock）
    sessions.json                  # nodeId → { sessionId, createdAt, lastUsedAt, agentOptions? }（一个节点一个会话）
    messages.jsonl                 # 流程收件箱（append + 分页；长正文只存头部 + bodyPath/bodyChars）
    inbox/                         # 收件箱长正文全文（<messageId>.md；目录 0700 / 文件 0600）
    lock.json                      # 单写者租约（O_EXCL 创建；含 ownerId，租约握手用）
    verification/                  # 宿主检查私有登记（<executionId>/record.json；只有引擎持凭证可写；
                                   #   record 含 commandDigest / exitCode / reportSha256 / 节点 / attempt）
    meta.lock                      # run.json 写的跨进程锁
    .error                         # 写盘失败等异常侧车（不静默挂住）
    <nodeId>/
      <attemptId>.jsonl            # 该节点这一次执行的全部事件
      artifacts/                   # 该次执行的产物（需求清单 / 方案 / diff / 报告）
      # host-check-<executionId>.json：宿主检查执行记录（producer=host）
      # host-check-<executionId>-report.<ext>：报告副本（字节与 reportSha256 绑定）
      self-check-raw.json          # 节点自审的原始回报（不静默丢弃）
    .index                         # 可选：mtime 快速索引（实现可省，读时扫描兜底）
```

`runId / nodeId / attemptId` 一律过 `^[A-Za-z0-9._-]{1,64}$` 校验，防路径穿越。单条事件 ≤8KB、单批 ≤200 条、单 run 事件总量 ≤200000，超限 400 并给出当前用量。

`messages.jsonl` 的入站记录在正文 >1200 字时只存 1200 字头部，并带 `bodyPath`（`inbox/<messageId>.md`，run 目录内安全相对路径）与 `bodyChars`（全文字数，1..200000）；`run.json.input.messages` 用同一对字段，保证重启 / 续跑后提示词仍能指回全文。入站正文硬上限 200000 字（超过返回可读 400）。

### `run.json` 字段

`run.json` 是可变元数据，只有原子重写、没有事件改写。写入有跨进程 `meta.lock`（含租约 `execution` 世代更新与事件 fence 提交；claim 先递增 epoch 再发布 `lock.json`），损坏时先备份并拒绝覆盖（不会被默认值重建，也不会让 `seq` 回退成 1,1）。白名单字段：

| 字段 | 含义 |
|---|---|
| `id` / `name` / `flowId` / `flowName` | run 标识与所用流程 |
| `status` | `pending` / `running` / `done` / `failed` / `aborted` |
| `started` / `startedAt` / `endedAt` / `createdAt` / `updatedAt` | 生命周期时间 |
| `workspace` / `sessionMode` / `worktree` | 工作区 `{id, path}`、`sessionMode`、worktree 决策与原因 |
| `supervision` | run 级自审调度：`enabled` / `wakerSessionId` / `lastWokeAt` / `nextDueAt` / `wakes` / `failures` / `reason` |
| `nodeStatus` | 节点最新自审状态 `nodeId → {state, progress, summary, verdict, members, blockers, at}`；**256 KiB 字节预算**，超限裁剪并置 `nodeStatusTruncated` |
| `machine` | 状态机快照 `{version, snapshot?, savedAt?}`；**24 KiB 预算**，超限只丢 `snapshot`、保留 `version` 并置 `machineTruncated` |
| `limits` | 生效的 `runTimeoutMs` / `nodeTimeoutMs` |
| `startOptions` | 创建 run 时记下的发起参数（`runtime.patchRunJson` 的唯一写路径） |
| `progress` / `live` / `input` / `inbox` | 进度、运行时快照、启动输入、收件箱配置 |
| `nodeDone` / `nodeTotal` / `tokenTotal` / `eventCount` / `lastSeq` / `seq` / `unkeyedCalls` / `tokenTotalApprox` | 计数与用量汇总（列表只读 `run.json`，不读全量事件） |
| `tokenCoverage` | run 级 token 覆盖度 `{complete, missing: [{nodeId, attemptId}], buckets: {seen, missing}}`：`complete` 只反映结构完整性（`missing` 空且 `unkeyedCalls === 0`），`buckets` 只说明四个桶哪些报过数值、不压 `complete`。语义与判定见 [design/05 §3](../design/05-run-log.md)；老 run 没有该字段按 `{complete:true}` 处理 |
| `sessions` | 会话索引（与 `sessions.json` 同源） |
| `execution` | 持久执行世代 `{epoch, ownerId, state}`：每次 claim +1；`state ∈ active/released/settled`。失权收口按它做条件写 |

`nodeStatus` 与 `machine` 是两条独立通道，各自量各自的预算；`nodeStatus` 被裁剪不影响 `machine`，反之亦然。

### 状态机快照只是缓存

`run.json.machine` 供恢复加速；**事件流是唯一真相**，任何冲突以 runlog 事件流为准（[design/08 §6](../design/08-state-machine.md)）。生产路径只从初态重放，中途续跑未支持。每次转移额外写一条 `machine/transition` **观测事件**（日志抽屉里的 `⇢`）——只给人看、不参与决策，也不进冻结的 17 种基础事件。`FLOW_STUDIO_FLOW_MACHINE=0` 可回退 0.8.x 的旧主循环（逃生门，留一个发布周期）。

### 写盘失败与崩溃

- 写盘失败把 run 标成 `failed` 并留 `.error` 侧车，不静默挂住；错误文案与实际状态一致，不留 `*.tmp-*`。
- `appendEvents` 先分配 `seq` 再写事件（崩溃不产生重复 seq）、半行自动断开；启动用 `repairRunCounters` 修计数。
- 重启后把「`running` 但本进程无实例」的 run 收成 `failed`（跨进程租约保守跳过）；租约过期就地 re-claim，0 字节锁可接管。

## Worktree

`worktree.enabled=true` 时根是 `$DSH_HOME/flow-studio/worktrees/<workspaceId>/<runId>`，分支 `flow/<runId>`（重名依次 `-2`…），base 取工作区 `HEAD`；节点会话与外部 executor 的 `cwd` 都用这份副本。

- **由 `start` 决策**：`run.json.workspace / worktree / sessionMode` 一次写入；工作区是 git 仓库根时 `auto` 才建，建失败如实落 `enabled:false, reason:'create-failed: …'`，绝不假装隔离。`on` 必须开、`off` 不开。
- **收尾不自动删**：用户可能还要进去看产物、跑测试。`DELETE /runs/<runId>` 只删 run 目录、保留 worktree 并把指针记进孤儿清单。
- **回收**：`removeWorktree()` 先校验路径必须落在 `<root>/<workspaceId>/` 下，再执行 `git -C <workspace> worktree remove [--force] <path>`；HTTP 入口是 `DELETE /runs/<runId>/worktree` 与 `POST /worktrees {action:'prune', keepRunIds?}`，模型工具是 `flow_worktrees`。prune 会连 `flow/` 前缀的分支一起回收，**绝不碰用户分支**；分支删不掉只记 `skipped` + `branchWarning`，不影响目录清理。
- **判孤儿**：目录在、对应 run 已删、或 `.git/worktrees` 记录残留，都算孤儿；清理顺序是先 prune（或对仍存在的 run 走 HTTP DELETE），再确认目录消失。

## 延伸阅读

- 事件格式与 kind：[运行日志](run-log.md) → [design/05](../design/05-run-log.md)
- 校验规则实现：`src/model.js` 的 `validateFlow` / `validateFlowForRun`
- 运行模型与 worktree 决策：[design/07](../design/07-runtime-0.7.md)
