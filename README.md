# dsh-flow-studio

**当前版本：0.8.0**

> DeepSeek Harness 的**智能体工作流编排工作室**：在 Web 端用画布拖拽节点，把一条研发流水线画出来，
> 每个节点配成一个 agent 角色（单个 agent，或主管 + 若干子 agent），节点之间用「正常流转」和「打回」两种线连起来，
> 流程模板落到本机，随时打开继续改。

第一版（0.1.0）交付**设计器**：画布 + 节点配置 + 状态流转与打回循环 + 模板存储 + 结构校验。

**0.2.0** 是照设计终稿重写的设计器：208×96 节点卡（主从 208×116，成员行常驻）、打回线走下方**正交航道**
（每侧 6 个槽位，超过 6 条确定性降级成双线 + `+N` 角标）、选中用中性色 / 运行用 business 蓝、
全览单一世界坐标源（`fit = min((W−96)/boundsW, (H−96)/boundsH)`，地板 15%，装不下时提示「还有 N 列在视野外」）、
LOD 三档（60% / 45%）、键盘也能连线（`C` → `Tab` → `Enter`）、保存失败落**本地草稿**并能恢复。
设计依据在 [`docs/DESIGN.md`](docs/DESIGN.md)（四份分册 + [`docs/design/REVIEW.md`](docs/design/REVIEW.md) 的独立审核与逐条裁决）。

数据模型已经按「可执行」的形态设计：
未识别字段原样收进 `extras`（有界、坏输入不抛错），后续加字段不会被保存链静默丢掉。

**0.3.0 加上了运行日志的骨架**（[`docs/design/05-run-log.md`](docs/design/05-run-log.md)）：
每次运行落 `$DSH_HOME/flow-studio/runs/<runId>/`（append-only JSONL + 原子 `run.json`），
事件带 `runId / attemptId / nodeId / memberId / seq / traceId / ts`，底部抽屉能看 run 列表、事件流、详情与
token 四段合计，也支持导出 markdown。指标按契约确定性聚合：token 四桶、skill 覆盖率（唯一 skill 去重）、
findings 未解决/已复验、打回计数、阶段进度（打回后旧通过失效），以及**质量结论**——
后者要求验收条目、测试报告、规范检查、审查结论、P0/P1 五类证据齐全且可复核，缺证据一律「未检测」，不给绿灯。
**0.4.0 接上执行引擎**（[`docs/design/06-execution-engine.md`](docs/design/06-execution-engine.md)）：
点「运行」把图编译成执行计划，每个节点起一个真实的节点会话（v0.7 起默认是顶层会话；
单个 agent，或主管 + 子 agent），
节点产物经结构化输出在节点之间传递，打回线按判定真的回退并累加 attempt。跑之前先把图校验一遍：
成环、断头路、多出边、打回指向结束节点一律 400 拒跑，不会跑到一半才卡死；
「缺任务」在客户端点运行前就拦住（`validateFlow` 的 error），「缺角色」只告警不拦（引擎允许，执行时按任务描述兜底）。
运行期间画布结构锁死、只读观察，可随时停止；单写者租约用 `O_EXCL` 原子创建 `lock.json`，
过期租约的接管要先跑一次「接管选举」（意图文件全序比较，只有一个赢家能删旧锁建新锁），
跨进程抢同一个 run 只有一个赢家——回归测试用真实子进程抢锁，覆盖「过期租约」与「崩溃残留锁」两条路径；
写盘失败会把 run 标成 `failed` 并留 `.error` 侧车，不静默挂住；预算按 run 限步数 / 墙钟 / 产物字节。
模型自述的证据（`provenance=model-claim`）必须对得上 `artifact/write` 的 path + sha256 且文件真实存在，
对不上就降级成「未检测」——**质量结论不接受自证**；返工后上一轮判过的失败项必须在本轮**重新判成通过**才算清账，
改报「跳过」也洗不白。运行前校验与引擎同一口径（成环 / 多出边 / 打回指向非阶段节点），在发请求之前就拦住。

> 0.4.1 补的是租约的**跨进程互斥**：过期租约的接管此前是「读 → 改名搬走 → 新建」，
> 那不是 CAS（读到的瞬间锁可能已被别人换成新的），8 个进程同时接管会出现多个赢家；
> 现在先跑一次「接管选举」，只有赢家能动旧锁，回归测试覆盖过期租约与崩溃残留锁两条路径。

**0.4.2 修的是「指标可信」与「真能上手」**（八条实测缺陷）：

- **画布换成 React Flow 12**：拖拽 / 平移缩放 / 端口连线 / 小地图式导航交给库，自研只保留有业务语义的部分
  （打回航道槽位、节点卡规格、键盘连线、SSR 静态回退）。内置 LOD 三档与暗色主题，节点卡在「全览」缩放档仍可读。
- **质量结论不再自证**：证据按「谁写的产物」分级——节点自己写、自己引的是**自证**；引用上游产物是跨节点复核；
  宿主产出的证据另标 `producer=host`。任意一类证据指标（验收 / 测试 / 规范）**全部是自证**时，结论降为 `warn`
  「缺独立复核」而不是给绿灯——真实运行里要拿到 `pass`，每一类证据至少得有一条独立来源。
- **返工账本不缩水**：上一轮报过 10 条验收，这一轮只报 1 条不算「1/1 全过」；上一轮出现过、本轮没有复判为通过的
  标识一律计入未复判，指标降 `unknown`（测试套件、规则集同样）。
- **P1/P2 压住绿灯**：只剩未解决的 P1 / P2 时结论是 `warn` 并写清条数，只有 P0 才是 `fail`。
- **上游产物真的传下去**：下游提示词里带上最近 1–2 个上游产物的**有界正文**（单产物 1200 字 / 总 3000 字），
  不再只是「有个文件叫 x」；读不到就退回只给路径，不炸 run。
- **一次节点失败不再炸整场**：节点异常 / 超时先重试一次（`FLOW_STUDIO_NODE_RETRIES` 可调，0–5），
  重试用尽只让该节点失败，已完成的证据全保留、`run failed` 也能照常复算指标；重试痕迹写在 `node/start{data.retry}`。
- **并发保存有序**：流程文件带 `version`，保存是乐观锁——版本不符返回 **409** 且磁盘零改动；
  客户端弹出「用我的版本覆盖 / 载入服务器版本」两条出口，不再后写静默覆盖先写。
- **画布与草稿不再卡**：拖拽期间不提交顶层状态、只在松手时提交一次，节点与边都 `React.memo` 且 props 引用稳定；
  本地草稿写盘改成 600ms 去抖（最长 2s 强制落一次，页面隐藏 / 卸载立即 flush），敲一个字不再序列化整份流程。
- **运行详情能放大、能看清 agent 在干什么**：日志抽屉支持「拉高 / 全屏 / 还原」三档与区域独立展开，
  长文本（agent 消息、错误、失败原因）可展开全文或弹层看完整内容（Esc 关闭、可复制）；
  节点运行详情面板给出角色/模式、attempt、**最近几条 agent 发言**、最近工具调用、token 用量、成员活动、
  已写产物与失败原因，运行中随轮询实时刷新。

**0.6.0 让流程能收外部消息**：`flow_send_message` / `flow_reply` + `POST /runs/<id>/messages`，
消息进入口节点后往下流；一个节点一个会话（打回重跑 / 新消息都注入同一个会话），回复支持
`session` / `http` / `none` 三种通道。运行日志、指标、收件箱与审计契约见
[05](docs/design/05-run-log.md) / [04](docs/design/04-metrics.md) / [06](docs/design/06-execution-engine.md)。

**0.7.0 是运行模型改造**（[07 运行模型](docs/design/07-runtime-0.7.md)）：

- **节点可换外部 executor**：`node.executor = dsh | codex | custom`。codex 起
  `codex exec --json --output-schema …`，custom 跑 `sh -c <模板>`；过程输出映射成节点日志与
  `model/call` 用量，结构化判定仍按同一份 `outputSchema` 解析。外部 executor 只允许 single，
  非法配置**能保存、不能开跑**。**codex 路径已用本机 `codex-cli 0.166.0` 真跑验证**
  （单次 exec 直连 + 整条 run，见 06 册 §17.9）；`--output-schema` 会自动转成 strict 形态，
  否则 codex 服务端会以 `additionalProperties` 报 400。
- **节点会话是顶层会话**：默认 `ctx.agents.create` 建独立会话（不挂父会话），在会话列表能看到、
  能点开接管；run 收尾 `dispose()` 只关句柄，不删日志。
- **worktree 由 start 决策**：`run.json.workspace / worktree / sessionMode` 一次写入；工作区是 git
  仓库根时 `auto` 才建 worktree，建失败如实落 `enabled:false`，绝不假装隔离。
- **并发不设上限、按工作区分组**：每个 run 一个引擎实例；唯一 409 是同一个 runId 已在跑；
  `GET /runs?workspaceId=` 过滤，左栏按工作区分组。
- **内建 supervision**：`flow_start` 启动的 run 默认登记调度（15s tick，healthy 180s / 异常 60s /
  pending 30s），到点自动唤醒发起会话；连续 3 次唤醒失败降级关闭。HTTP 起的 run 默认不开，
  可用 `flow_supervise` 或 `POST /runs/<id>/supervision` 打开。

**0.8.0 给每个节点主管会话加了自审闹钟**（[07 §11](docs/design/07-runtime-0.7.md) /
[06 §19](docs/design/06-execution-engine.md)）：建会话即登记、attempt 结束注销，到点让节点用
结构化 `node/status` 回报状态；`state=done` + 合法 verdict 可与 `whenIdle` 竞速提前完成，
`blocked` 且进度不变会在 `flow_watch` 里给建议。闹钟状态只在内存，进程重启不恢复；
外部 executor 节点没有会话，不挂闹钟。

## 在会话里开流程，让主 agent 自己盯着

不用先去画布点运行：在任意会话里让主 agent 直接开跑，它自己定时醒来自查「整条流水线是否正常运转」。

```
flow_list       → 看有哪些流程模板
flow_start      → 在**当前会话**里开跑，并自动开启内建 supervision
flow_watch      → 审查整个工作流：偏航 / 卡死 / 打回死循环 / 并发乱序 / 超时风险 / 质量结论
flow_stop       → 停掉这次运行
flow_supervise  → 手动开 / 关某个 run 的内建定时自审
```

`flow_start` 启动成功后**默认开启内建 supervision**，到点由 runtime 唤醒发起会话，
不需要再挂 `proactive_set`；返回的 `supervision.alarmPrompt` / `nextCheckSeconds` 从 0.5.0 保留，
只在 `supervision.enabled=false`（引擎不支持 / 登记失败）时作为手动回退。
醒来后调 `flow_watch`，`verdict=healthy` 就安静结束本轮，出现异常或跑完才通知人。

工作区的答案是**不用手填**：模板存在 `$DSH_HOME/flow-studio/flows/`（全局）；
`flow_start` 默认取当前会话的 `header.cwd` 作工作区，`engine.start` 再按 `worktree` 策略决定是否
建隔离副本，最终写进 `run.json.workspace / worktree`。节点主管会话是顶层会话（不是挂在父会话下的
子 agent），它的 `cwd` 用 worktree 路径或工作区路径；外部 executor 同理。

## 流程能收外部消息，一个节点只有一个会话

外部 agent / 人往流程里发消息，消息从入口节点（需求分析）往下流：

```
POST /api/flow-studio/runs/<runId>/messages
  { "from": "某个 agent", "text": "…", "nodeId?": "n_dev", "reply": { "kind": "session", "sessionId": "…" } }
```

- **节点没启动** → 起一个顶层节点会话把消息带进去；run 还没开始 → 这条消息就是本次运行的启动输入。
- **节点正在跑** → 通过 `agent.followup` 把消息注入到**同一个会话**（上下文注入），不打断当前回合。
- **节点还没轮到** → 消息入队，引擎推进到该节点时并进提示词；入口消息在后续每个阶段节点都可见（最多 5 条、单条 ≤1200 字）。
- **一个节点一个会话**：`runs/<runId>/sessions.json` 记着 nodeId → sessionId，二次激活（打回重跑 / 收到新消息）复用同一会话
  （活的走 `agents.get`，冷的或被压缩过的走 `agents.resume`），不再新开会话；run 结束或停止时统一
  `dispose()` 句柄，**不删日志、不删会话文件**（仍可从列表点开 / `resume`）。

回复通道要配置（默认只记进运行日志）：

| `reply.kind` | 行为 |
|---|---|
| `session` | 发回指定会话（`agents.get`/`resume` + `followup`，正文带 `[flow:… · 节点名]` 来源标记） |
| `http` | `POST` 到外部给的 URL（`Bearer` 取自配置的环境变量），body `{runId,nodeId,messageId,text}` |
| `none` / 未配置 | 只写 `message/out` 事件，工具返回「没有外部回复通道」 |

节点里的 agent 用 `flow_reply` 回消息（工具按会话反查 run/node，不用手填 id）；别的 agent 用
`flow_send_message` 往流程里发消息。运行中可以 `POST /runs/<id>/inbox` 动态改回复目标，
`GET /runs/<id>/messages` 看收件箱。

## 它解决什么

把一句「帮我做个 X」变成一条能盯住的流水线：

```
任务输入 → 需求分析 → 方案设计 → 结构设计 → 开发 → 测试 → 代码审查 → 完成
                ↑           │            │              │        │
                └──方案打回──┘            │              │        │
                            └──结构打回───┘              │        │
                                          └──测试打回────┘        │
                                                    └──审查打回───┘
```

- **每个节点就是一个 agent**：写清「它是什么人」（角色定位）和「它负责什么」（任务），
  选「单个 agent」还是「主管 + 子 agent」，主从模式下再逐个配子 agent 的分工。
  出厂模板的六个阶段节点默认就是「主管 + 3 个子 agent」（例如需求分析 = 业务拆解 / 验收条目 / 风险与边界），
  在检查器里可以把执行方式改回单个 agent。
- **team 模式的成本要知道**：每个节点会起 1 个主管 + N 个成员会话，跑完整条链的 token 开销
  显著高于 single（六阶段全 team 时是十几个会话在跑）。先用 single 试跑、分工稳定后再切 team 更划算。
- **节点可以挂 skill**：从当前 profile 已注册的 skill 里勾选（例如「怎么开发 Java 服务」这类开发规范），
  运行时要求节点会话先加载再干活。
- **节点可以换外部 executor**：`dsh`（默认，走节点会话）/ `codex`（`codex exec --json`）/
  `custom`（`sh -c` 模板，用 `{prompt}` / `{schema}` / `{cwd}` 占位）。外部 executor 只允许 single，
  配置不合法能保存但开不了跑。
- **运行按工作区分组、并发不设上限**：每个 run 一个引擎实例，同工作区也可以同时跑多个；
  左栏按 `workspacePath` 分组，`GET /runs?workspaceId=` 可过滤。worktree 由 `engine.start` 决定，
  建失败如实写 `enabled:false`。
- **内建 supervision**：`flow_start` 起的 run 默认由 runtime 定时唤醒发起会话复查，不用外部插件，
  也不用自己挂闹钟；连续 3 次唤醒失败自动降级。
- **每个节点主管会话都有自审闹钟**：`agents.create` 成功后自动登记（默认 120s 一次），到点按会话
  状态走 `inject` / `followup` / `resume`，要求节点用 json 代码块回报
  `state / progress / summary / members / blockers / verdict`；`state=done` + 合法 verdict 可与
  `whenIdle` 竞速提前收口（`node/end.extra.completedBy='self-check'`），连续 3 次投递失败自动停摆。
  外部 executor 节点没有会话，不挂闹钟。
- **打回是图的一部分，不是例外**：一条打回线指向任意上游节点，自动构成循环；每个节点可单独设打回上限。
- **模板存在本机**：`$DSH_HOME/flow-studio/flows/<id>.json`，换浏览器、换设备都还在。

## 界面

| 区域 | 做什么 |
|---|---|
| 左侧 | 流程模板列表：新建 / 打开 / 删除 |
| 中间 | 画布：拖动节点、从右侧圆点拖到另一个节点建连线、双击空白处新增节点、裸滚轮缩放（指针锚定）、Shift+滚轮横移、中键/空格拖平移、`Alt` 拖动绕过 4px 吸附；双击空白以外的「全览」把整张图装进视口 |
| 右侧 | 检查器：选中节点或连线后配置；带「位置与连线」组——X/Y 坐标、四向 4px 微调（Shift 20px）、「连接到…」下拉 |
| 底栏 | 节点 / 连线 / 打回统计 + 结构校验结论（点开看逐条问题，可跳转到对应节点）+ 保存状态（含「本地草稿」） |

连线会自动判方向：**目标在下游就建「正常流转」，目标在上游就自动建成「打回」**，建完可以在检查器里改。

不用鼠标也能连：选中节点 → `C` 进入连线待定 → `Tab` / 方向键选目标（状态栏会念「从 X 到 Y」）→ `Enter` 建边 → `Esc` 取消。
单字母快捷键只在画布上下文（已选节点、焦点不在输入框）时生效。
保存失败或断连时改动落在 `localStorage` 的 `flow-studio:draft:<flowId>`，下次打开会问「恢复 / 丢弃」；
保存成功才显示「已保存」，草稿随之清掉。

## 安装

```sh
# 从私源安装固定版本（@feiyueve scope）
dsh plugin --profile web add @feiyueve/dsh-flow-studio@0.7.0

# 本地目录开发
git clone git@github.com:FeiyuEVE/dsh-flow-studio.git
dsh plugin --profile web add ./dsh-flow-studio
```

装完刷新页面，侧栏出现「流程编排」图标。Host 半边（路由）需要重启 `dsh web` 才挂载。

流程与 run 都落在 `$DSH_HOME/flow-studio/`（`flows/`、`runs/`、`worktrees/`，目录 0700、文件 0600）；
没有另外的覆盖变量。worktree 根是 `$DSH_HOME/flow-studio/worktrees/<workspaceId>/<runId>`。

## 数据模型

一份流程就是一个 JSON：

```jsonc
{
  "schemaVersion": 1,
  "id": "flow-ab12cd34ef",
  "name": "标准研发流水线",
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
      "model": "",                           // 模型覆盖，空 = 跟随会话
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

校验分两级：**error**（跑不起来：没有开始节点、有孤立节点、打回目标不在上游、阶段节点没写任务、
custom executor 缺命令、外部 executor 配了 team…）与 **warning**（能存但作者大概还想改：没写角色、
主从节点没配子 agent、走不到结束节点…）。

v0.7 起**保存宽松、启动严格**：`POST /flows` / `PUT /flows/<id>` 只拒绝「不是 JSON 对象」的请求体，
`validation.errors` 非空也照存（画布 600ms 防抖自动保存，半成品必须存得下）；真正拦人的是
`POST /runs/<id>/start` 与 `flow_start` 的 `validateFlowForRun`，非法流程返回 400，不会开跑。

## Host 接口

单条 `prefix` 路由 `/api/flow-studio`，同源 fetch 调用：

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
| GET/DELETE | `/runs/<runId>` | run 详情（节点与 attempt 索引 + `progress.nodes` + 工作区 / worktree / sessionMode / supervision / nodeStatus）/ 删除整个 run（租约持有中 → 409） |
| GET/POST | `/runs/<runId>/supervision` | 读 `run.json.supervision` + 调度器状态 / 开或关内建 supervision（`{enabled, wakerSessionId?}`；对已收尾 run 开启 → 400） |
| GET/POST | `/runs/<runId>/events` | 事件流（`nodeId`、`attemptId`、`kind`、`since`、`order=desc`、`limit`）/ 追加事件（≤200 条/批，整批校验） |
| GET | `/runs/<runId>/summary` | 指标聚合（token / skill 覆盖率 / findings / 打回 / 进度 / 质量结论）+ `nodeStatus` |
| GET | `/runs/<runId>/export` | 导出 markdown |

**鉴权与 `/api` 同口径**：插件路由虽然绕过了 webserver 的 `/api` 通用鉴权（最长前缀优先），
但每个 handler 入口都会调宿主 `ctx.get('connection')?.requestRejection(req)`，把判定权交回宿主
（401/403 与 `/api` 一致；拿不到该服务时 **fail-closed 503**，绝不放行）。另有可选第二道闸
`FLOW_STUDIO_TOKEN`（≥16 字符，只认 `Authorization: Bearer`；`?token=` 仅导出接口允许）。
`/health` 在未鉴权时只说「认证档位」，不报内部路径。

## 开发

```sh
npm install
npm run build      # src/client/entry.js -> lib/client.js（esbuild，单文件 ≈403 KB，含 React Flow 12）+ 复制 Host 模块
npm test           # 19 个自检文件，共 540 组（其中 7 个套件显式计数，合计 1845 条断言）
node test/render.test.mjs   # SSR + 构建产物加载，70 组
bash scripts/e2e-docker.sh  # 容器测试台端到端（真装真跑，桩引擎）
```

- `test/model.test.mjs` —— 出厂模板合法（六个阶段默认「主管 + 3 个子 agent」，往返保存不丢成员）、坏数据收敛、四类结构错误能被抓出来、未知字段进 `extras` 不丢。
- `test/geometry.test.mjs` —— 世界边界唯一来源、fit 公式与 15% 地板、6 槽与第 7 条降级、tie-break 与输入顺序无关。
- `test/link.test.mjs` —— 键盘连线状态机：候选顺序、循环移动、Enter 确认、方向规则、可读播报。
- `test/draft.test.mjs` —— 草稿键名、写入读回、无 localStorage 时的内存退化、坏 JSON、内容指纹与恢复判定。
- `test/host.test.mjs` —— 存储增删改查 + 真实 HTTP 语义（伪造最小 ctx，把 `apply()` 注册的路由取出来直接喂 req/res）；
  v0.7 组覆盖保存宽松（空流程 / executor 非法也 200 + validation）、`?workspaceId=` 过滤、
  `POST /runs/<id>/supervision` 的 400/404/enable/disable 与已收尾 run 拒绝开启；
  v0.8 组覆盖 `GET /runs` 列表行 / 详情 / summary 三处 `nodeStatus`（缺省 `{}`）。
- `test/runlog.test.mjs` —— 事件校验与归一化（白名单、有界 `extra`、四桶用量、run/节点级字段规则、`callId` 必填）；
  v0.8 组覆盖 `node/status` 通过校验、可选字段收敛、成员 / 阻塞项有界与坏输入拒绝。
- `test/runstore.test.mjs` —— run 目录读写、分页过滤、删除、路径穿越拒绝、超限拒绝、坏 run 隔离、计数器；
  `nodeStatus` 的写入 / 归一化由 host 组经真实写路径间接覆盖（本文件暂无独立用例）。
- `test/metrics.test.mjs` —— 指标口径：token 四桶与重放替换、skill 唯一覆盖率、findings 三态、打回失效、质量判定表（含不明证据不给绿灯）。
- `test/engine.test.mjs` —— 执行引擎：结构不合格拒跑、单写者租约与同 runId 二次 start 409、打回按 attempt 重跑、
  预算中断、写盘失败终态、证据对账、上游产物正文进提示词、证据引用透传与回退、节点失败重试与失败隔离、桩模式双闸门；
  v0.7 组另覆盖工作区 / worktree、sessionMode 降级可见、外部 executor（custom 成功 / 非 0 退出 / stop / 缺命令 / 重试）；
  v0.8 组覆盖节点闹钟：建会话即登记、attempt 结束注销先于 run 收尾、打回重跑重新登记、`node/status`
  三处可见、`done+verdict` 提前完成（`completedBy:'self-check'`）、非法 verdict 不提前完成、
  未注入调度器时退回 v0.7、外部 executor 不登记。
- `test/worktree.test.mjs` —— 工作区与 worktree：`workspaceIdFor` 稳定、真 git 仓库根 / 子目录 / 非 git 的区分、
  `git` 不可用与「不是仓库」分开、`auto/on/off` 决策、分支冲突 `-2`、真 worktree 落盘、脏 worktree 删除校验与路径越界拒绝。
- `test/executor.test.mjs` —— 外部 executor：三档归一化与 `EXECUTOR_INVALID`、codex argv 顺序、strict schema 转换、JSONL 的
  final / usage / 过程 / 未知事件、custom 占位符与 shell 转义、超时 / abort / 非 0 退出 / spawn 失败、
  跨 chunk 半行、真 node 子进程端到端；**不依赖真 codex、不联网**。
- `test/runtime.test.mjs` —— 进程级注册表：两个 runId 并发跑通、同 runId 二次 start 409、失败实例摘除、
  sessionIndex 跨实例共享、`sweep` 崩溃残留、`createEngine/new Engine` 旧用法兼容、supervision 接线与收尾落盘；
  v0.8 组覆盖 `wake` 的 idle→followup / busy→inject / 拿不到→skip、提示词、收尾 `unregisterRun` 与 `dispose` 停表。
- `test/supervise.test.mjs` —— 内建 supervision：`planWake` 五档间隔、到点只唤醒一次、失败 3 次降级 /
  成功清零 / 重启恢复 / 终态摘除 / 坏日期不抛错 / tick 重入保护；v0.8 节点闹钟组覆盖
  `parseNodeStatus` 的围栏 / 裸 JSON / 默认值 / 大小写 / 取整 / 上限，`NodeSupervisionScheduler`
  的 120s 默认间隔、`skip` 推进但不计 `wakes`、连续 3 次失败停摆、刷新与三种注销。
- `test/client-perf.test.mjs` —— 客户端性能回归：拖动中 0 次提交 / 松手恰好 1 次、锁定不提交、
  节点与边是 `React.memo` 且相同输入复用同一对象、草稿去抖（5 次变更只写 1 次、maxWait 必落、隐藏立即 flush）。
- `test/logdrawer.test.mjs` —— 运行详情：抽屉三档与全屏类、Esc 逐档还原、节点面板四类实时字段、
  缺失字段降级占位、长文本展开全文弹层、区域开关与窄屏单列、新 CSS 只用主题 token。
- `test/audit.test.mjs` —— 工作流健康审计（纯函数）：pending / healthy / stalled / looping / deviating /
  no-progress / done / failed / aborted 九种裁决，以及打回后重跑不误判偏航、坏输入不抛错。
- `test/tools.test.mjs` —— 会话内启停的五个基础模型工具：按 id/名字启动、同名多份列候选、结构不合法不建 run、
  `options.parent === exec.agent`（绑定发起会话与工作区）、flow_start 自动开启 supervision / 失败回退、
  flow_supervise 开关、flow_watch 走真实审计、flow_stop 业务态、输出 lossless、无 tools 服务时不炸；
  v0.8 组覆盖 `flow_watch.nodeStatus` 与 `blocked` + 连续两次进度不变的 `recommended` 提示。
- `test/inbox.test.mjs` —— 流程收件箱与节点会话复用：`message/in`/`message/out` 事件与有界截断、messages.jsonl
  追加与分页、目标节点三路解析、活/冷会话注入、未开始当启动输入、排队与推进时并进提示词、下游可见且有界、
  `flow_reply` 三种回复通道、`flow_send_message` 省略 runId、HTTP 401/400/200、二次激活只起一次会话、
  sessions.json 容错、run 收尾 dispose、无 agents 服务退化。
- `test/render.test.mjs` —— 用真实 React 18 把每个组件 SSR 渲染一遍；再把构建产物 `lib/client.js` 放进只有
  `window.__ModuleLoader__` 的假环境里执行，验证注册 id、两个 slot 成对注册、面板能渲染出根节点；
  运行日志抽屉的收起/展开、空态、错误态、结论 pill 与键盘开合也在这里断言；
  v0.8 组覆盖运行详情「节点状态」区块（标题 / 状态徽标 / 进度条 / verdict / members / blockers /
  坏数据降级 / 超过 6 个节点内部滚动）。

> SSR 只跑首次渲染，不跑 `useEffect`，也不测拖拽 / 缩放这些交互。**这不等于浏览器验证。**

## 路线图

已交付：0.3 运行日志与指标、0.4 执行引擎、0.5 会话内启停与健康审计、0.6 流程收件箱、
0.7 运行模型（worktree / 顶层会话 / 并发 / 外部 executor / 内建 supervision）、
0.8 节点闹钟（每个节点主管会话的结构化自审与提前完成信号）。

未排期：

- **实时协同**：保存已经是乐观锁（`version` + 409 + 客户端「覆盖 / 载入服务器版本」两条出口），
  但还没有多人实时编辑（看不到对方光标 / 没有自动合并），现在靠「刷新后重试」这条底线。
- **图中图**：一个节点内部再展开成子图（主管带子 agent 的可视化展开）。
- **独立证据源**：现在「独立复核」靠跨节点引用上游产物；下一步是让宿主自己跑测试 / 规范检查，
  产物带 `producer=host`（引擎与聚合层已认这个标记，缺的是真正的执行器）。
- **worktree 管理入口**：`removeWorktree()` 已有路径校验与删除实现，但还没有 HTTP / 模型工具入口。

## 常见问题

### 为什么节点会话能在会话列表看到？它不是「子 agent」吗？

v0.7 起节点主管会话走 `ctx.agents.create`，是**顶层会话**：session header 里没有
`parentSession` / `origin`，`delegationDepth: 0`，所以 Web 侧栏能看到、能点开接管。
`team` 节点的成员才是主管委派出的子会话（header 带 `parentSession` / `origin:'subagent'`）。
判断是否顶层**看 session header，不看 `roots()`**——`resume` 之后 agent 在运行时也是 root，
但持久化血缘不变。run 收尾的 `dispose()` 只关句柄、不删日志，会话仍在列表（`agentAvailable:false`）、
磁盘文件仍在、之后仍可 `resume`。只 `create` 不跑 turn 的 `blank` 会话 API 有、Web 侧栏看不到；
节点会话一定会跑 turn，不受影响。

### worktree 建在哪？为什么不自动删？

`worktree.enabled=true` 时根是 `$DSH_HOME/flow-studio/worktrees/<workspaceId>/<runId>`，分支
`flow/<runId>`（重名依次 `-2`…），base 取工作区 `HEAD`；节点会话与外部 executor 的 `cwd`
都用这份副本。run 收尾**不自动删**：用户可能还要进去看产物、跑测试。删除只走
`removeWorktree()`：先校验路径必须落在 `<root>/<workspaceId>/` 下，再执行
`git -C <workspace> worktree remove [--force] <path>`；目前没有 HTTP / 模型工具入口。
`auto` 策略下建失败会如实写 `enabled:false, reason:'create-failed: …'`，不会假装已隔离。

### 节点闹钟和 run 级 supervision 有什么区别？

| | run 级 supervision | 节点闹钟 |
|---|---|---|
| 叫醒谁 | 发起这个 run 的会话（`wakerSessionId`） | 单个节点主管会话（`sessionId`） |
| 问什么 | 「整个 run 是否正常运转」，要求调 `flow_watch` | 「你这个节点现在什么状态」，要求结构化回报 |
| 回报落在哪 | `run.json.supervision` | `node/status` 事件 + `run.json.nodeStatus` + `live.nodeStatus` |
| 节奏 | healthy 180s / 异常 60s / pending 30s / 终态停 | 默认 120s 一次（每 15s 扫到点） |
| 什么时候停 | run 收尾 / 连续 3 次唤醒失败 | attempt 结束就注销；run 收尾再 `unregisterRun` |
| 连续 3 次失败 | 关闭调度并写 `wake-failed` | 停摆（`enabled:false`），条目仍可查 |

两个调度器都在 `createRuntime()` 里创建，但各自一个 `setInterval`、各自一份状态，**不是同一个 tick**。
节点闹钟只在内存，进程重启不恢复；外部 executor 节点没有会话，不挂闹钟。
自审说 `done` 只是「提前完成信号」，会与 `whenIdle` 竞速（采用时 `node/end.extra.completedBy='self-check'`），
**不能**替代结构化 verdict 的合法性检查。

## 先搜现成的（按 `PLUGIN-SEARCH.md`）

新建插件前先搜过一轮，留痕如下（2026-11-06）：

- **形态关键词**：`dsh workflow / canvas / graph / orchestration` + `reactflow` / `react-flow`，
  GitHub 仓库搜索命中 587 / 203 / 271 / 199 条；代码搜索 `"dsh.bundle" filename:package.json + canvas` 命中 2 条、
  `"reactflow" filename:package.json dsh` 命中 50 条；npm `dsh workflow|graph|orchestration` 逐条看过包名。
- **最接近的候选**：
  - `GZX2211/dsh-Visual-Workflow`（★64，MIT，v0.10.3）——画布 + 节点级角色 + 主从多 agent 三件齐备，
    缺打回状态机与指标看板；仓库 40.8MB / 1536 文件，依赖 `@huggingface/transformers` → onnxruntime-node / sharp，
    `peerDependencies` 全是 `*`。
  - `chumingjun/dsh-harness-one`（★31）——React Flow 画布 + 8 类节点，但无主从编排、不声明 peer/engines。
  - `CodermanYHZ/dsh-node-flow`（★15）——最小画布骨架（`@xyflow/react` + zustand），2026-08 后停更。
  - `toolclub/dsh-agent-team-gui`（★288）——主从 + Run Center 指标最好，但无画布、peer 钉在 0.1.5 旧世代。
  - `miuzel/dsh-graph`（★25）——状态机 + 泳道看板那一半的现成范本，不是编排画布。
- **结论：自研**。理由：没有一个候选同时覆盖「画布 + 节点角色 + 主从 + 打回状态机 + 指标」；
  最接近的 Visual-Workflow 体量大、带原生编译依赖、且它的「回流重试」是节点级重试而不是显式的打回连边，
  要在 1536 个文件里再加两层（打回状态机 + 指标看板），代价高于按本仓的零依赖实现重写。
  **本仓从候选里借的是思路**：画布与检查器分离、节点级角色/模型覆盖、按 upstream 判打回方向。
  内置 `workflow` 工具（脚本编排 subagent）与 `dsh-advisor-flow`（会话级顾问）都不覆盖可视化与状态机。

## License

MIT
