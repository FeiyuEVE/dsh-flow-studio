# 版本历史（0.1 → 0.13.11）

按版本从旧到新。这里记录「哪一版加了什么、修了什么、留下什么边界」；当前行为以 [产品指南](../guide/overview.md) 与 [参考](../reference/host-api.md) 为准，README 不再承载历史。

## 0.1.0 — 设计器

交付**设计器**：画布 + 节点配置 + 状态流转与打回循环 + 模板存储 + 结构校验。

## 0.2.0 — 照设计终稿重写设计器

208×96 节点卡（主从 208×116，成员行常驻）、打回线走下方**正交航道**（每侧 6 个槽位，超过 6 条确定性降级成双线 + `+N` 角标）、选中用中性色 / 运行用 business 蓝、全览单一世界坐标源（`fit = min((W−96)/boundsW, (H−96)/boundsH)`，地板 15%，装不下时提示「还有 N 列在视野外」）、LOD 三档（60% / 45%）、键盘也能连线（`C` → `Tab` → `Enter`）、保存失败落**本地草稿**并能恢复。

设计依据在 [设计总案](../DESIGN.md)（四份分册 + [审核报告](../design/REVIEW.md) 的独立审核与逐条裁决）。

数据模型按「可执行」的形态设计：未识别字段原样收进 `extras`（有界、坏输入不抛错），后续加字段不会被保存链静默丢掉。

## 0.3.0 — 运行日志与指标骨架

加上运行日志骨架（[design/05](../design/05-run-log.md)）：每次运行落 `$DSH_HOME/flow-studio/runs/<runId>/`（append-only JSONL + 原子 `run.json`），事件带 `runId / attemptId / nodeId / memberId / seq / traceId / ts`，底部抽屉能看 run 列表、事件流、详情与 token 四段合计，也支持导出 markdown。

指标按契约确定性聚合：token 四桶、skill 覆盖率（唯一 skill 去重）、findings 未解决 / 已复验、打回计数、阶段进度（打回后旧通过失效），以及**质量结论**——后者要求验收条目、测试报告、规范检查、审查结论、P0/P1 五类证据齐全且可复核，缺证据一律「未检测」，不给绿灯。

## 0.4.0 — 执行引擎

点「运行」把图编译成执行计划，每个节点起一个真实的节点会话（v0.7 起默认是顶层会话；单个 agent，或主管 + 子 agent），节点产物经结构化输出在节点之间传递，打回线按判定真的回退并累加 attempt。

- **跑前校验**：成环、断头路、多出边、打回指向结束节点一律 400 拒跑，不会跑到一半才卡死；「缺任务」在客户端点运行前就拦住（`validateFlow` 的 error），「缺角色」只告警不拦（引擎允许，执行时按任务描述兜底）。
- **运行期锁结构**：画布结构锁死、只读观察，可随时停止。
- **单写者租约**：用 `O_EXCL` 原子创建 `lock.json`；过期租约的接管要先跑一次「接管选举」（意图文件全序比较，只有一个赢家能删旧锁建新锁），跨进程抢同一个 run 只有一个赢家——回归测试用真实子进程抢锁，覆盖「过期租约」与「崩溃残留锁」两条路径。
- **失败可见**：写盘失败会把 run 标成 `failed` 并留 `.error` 侧车，不静默挂住；预算按 run 限步数 / 墙钟 / 产物字节。
- **质量结论不接受自证**：模型自述的证据（`provenance=model-claim`）必须对得上 `artifact/write` 的 path + sha256 且文件真实存在，对不上就降级成「未检测」；返工后上一轮判过的失败项必须在本轮**重新判成通过**才算清账，改报「跳过」也洗不白。
- **运行前校验与引擎同一口径**（成环 / 多出边 / 打回指向非阶段节点），在发请求之前就拦住。

## 0.4.1 — 租约的跨进程互斥

补的是租约的**跨进程互斥**：过期租约的接管此前是「读 → 改名搬走 → 新建」，那不是 CAS（读到的瞬间锁可能已被别人换成新的），8 个进程同时接管会出现多个赢家；现在先跑一次「接管选举」，只有赢家能动旧锁，回归测试覆盖过期租约与崩溃残留锁两条路径。

## 0.4.2 — 指标可信与真能上手（实测缺陷收口）

- **画布换成 React Flow 12**：拖拽 / 平移缩放 / 端口连线 / 小地图式导航交给库，自研只保留有业务语义的部分（打回航道槽位、节点卡规格、键盘连线、SSR 静态回退）。内置 LOD 三档与暗色主题，节点卡在「全览」缩放档仍可读。
- **质量结论不再自证**：证据按「谁写的产物」分级——节点自己写、自己引的是**自证**；引用上游产物是跨节点复核；宿主产出的证据另标 `producer=host`。任意一类证据指标（验收 / 测试 / 规范）**全部是自证**时，结论降为 `warn`「缺独立复核」而不是给绿灯——真实运行里要拿到 `pass`，每一类证据至少得有一条独立来源。
- **返工账本不缩水**：上一轮报过 10 条验收，这一轮只报 1 条不算「1/1 全过」；上一轮出现过、本轮没有复判为通过的标识一律计入未复判，指标降 `unknown`（测试套件、规则集同样）。
- **P1/P2 压住绿灯**：只剩未解决的 P1 / P2 时结论是 `warn` 并写清条数，只有 P0 才是 `fail`。
- **上游产物真的传下去**：下游提示词里带上最近 1–2 个上游产物的**有界正文**（单产物 1200 字 / 总 3000 字），不再只是「有个文件叫 x」；读不到就退回只给路径，不炸 run。
- **一次节点失败不再炸整场**：节点异常 / 超时先重试一次（`FLOW_STUDIO_NODE_RETRIES` 可调，0–5），重试用尽只让该节点失败，已完成的证据全保留、`run failed` 也能照常复算指标；重试痕迹写在 `node/start{data.retry}`。
- **并发保存有序**：流程文件带 `version`，保存是乐观锁——版本不符返回 **409** 且磁盘零改动；客户端弹出「用我的版本覆盖 / 载入服务器版本」两条出口，不再后写静默覆盖先写。
- **画布与草稿不再卡**：拖拽期间不提交顶层状态、只在松手时提交一次，节点与边都 `React.memo` 且 props 引用稳定；本地草稿写盘改成 600ms 去抖（最长 2s 强制落一次，页面隐藏 / 卸载立即 flush），敲一个字不再序列化整份流程。
- **运行详情能放大、能看清 agent 在干什么**：日志抽屉支持「拉高 / 全屏 / 还原」三档与区域独立展开，长文本（agent 消息、错误、失败原因）可展开全文或弹层看完整内容（Esc 关闭、可复制）；节点运行详情面板给出角色 / 模式、attempt、**最近几条 agent 发言**、最近工具调用、token 用量、成员活动、已写产物与失败原因，运行中随轮询实时刷新。

## 0.5.0 — 会话内启停与健康审计

会话里可用 `flow_list` / `flow_start` / `flow_watch` / `flow_stop` 启停与审查流程；`flow_start` 返回 `supervision.alarmPrompt` / `nextCheckSeconds`。健康审计（纯函数）给出 `pending / healthy / stalled / looping / deviating / no-progress / done / failed / aborted` 九种裁决。

## 0.6.0 — 流程收件箱

流程能收外部消息：`flow_send_message` / `flow_reply` + `POST /runs/<id>/messages`，消息进入口节点后往下流；一个节点一个会话（打回重跑 / 新消息都注入同一个会话），回复支持 `session` / `http` / `none` 三种通道。运行日志、指标、收件箱与审计契约见 [05](../design/05-run-log.md) / [04](../design/04-metrics.md) / [06](../design/06-execution-engine.md)。

## 0.7.0 — 运行模型改造

- **节点可换外部 executor**：`node.executor = dsh | codex | custom`。codex 起 `codex exec --json --output-schema …`，custom 跑 `sh -c <模板>`；过程输出映射成节点日志与 `model/call` 用量，结构化判定仍按同一份 `outputSchema` 解析。外部 executor 只允许 single，非法配置**能保存、不能开跑**。**codex 路径已用本机 `codex-cli 0.166.0` 真跑验证**（单次 exec 直连 + 整条 run，见 [06 §17.9](../design/06-execution-engine.md)）；`--output-schema` 会自动转成 strict 形态，否则 codex 服务端会以 `additionalProperties` 报 400。
- **节点会话是顶层会话**：默认 `ctx.agents.create` 建独立会话（不挂父会话），在会话列表能看到、能点开接管；run 收尾 `dispose()` 只关句柄，不删日志。
- **worktree 由 start 决策**：`run.json.workspace / worktree / sessionMode` 一次写入；工作区是 git 仓库根时 `auto` 才建 worktree，建失败如实落 `enabled:false`，绝不假装隔离。
- **并发不设上限、按工作区分组**：每个 run 一个引擎实例；唯一 409 是同一个 runId 已在跑；`GET /runs?workspaceId=` 过滤，左栏按工作区分组。
- **内建 supervision**：`flow_start` 启动的 run 默认登记调度（15s tick，healthy 180s / 异常 60s / pending 30s），到点自动唤醒发起会话；连续 3 次唤醒失败降级关闭。HTTP 起的 run 默认不开，可用 `flow_supervise` 或 `POST /runs/<id>/supervision` 打开。

## 0.8.0 — 节点自审闹钟

给每个节点主管会话加了自审闹钟（[07 §11](../design/07-runtime-0.7.md) / [06 §19](../design/06-execution-engine.md)）：建会话即登记、attempt 结束注销，到点让节点用结构化 `node/status` 回报状态；`state=done` + 合法 verdict 可与 `whenIdle` 竞速提前完成，`blocked` 且进度不变会在 `flow_watch` 里给建议。外部 executor 节点没有会话，不挂闹钟。

## 0.8.1 — 10 路独立审计 → 修 BLOCKER

重点不是加功能而是堵漏：

- **发布链补门禁**：`prepack` / `pretest` 强制 `build`，`build.mjs` 逐字节比对 `src` 与 `lib`；干净检出发包若少了构建产物或带了陈旧模块，直接非零退出。
- **custom executor 不再拼 shell**：prompt 原文不进命令文本，改走「0700 临时文件（`FLOW_STUDIO_PROMPT_FILE`）+ `FLOW_STUDIO_PROMPT` + stdin」三条通道；`$(id -u)` / 反引号 / `$(rm -rf …)` 一律按原文处理。
- **run.json 单一写入口**：引擎与运行时都改走 `writeRunMeta`（同一把锁），`nodeStatus` 加 256 KiB 字节预算；元数据损坏时备份 + 拒绝覆盖，不再被默认值重建（也不会让 seq 回退成 1,1）。
- **启动必须显式工作区**：删掉 `process.cwd()` 回落，缺工作区 / 非目录 / 是文件一律 400，画布未选工作区时前端直接拦。
- **节点自审要求凭证**：回报必须回显 `attempt + nonce`，正式结论优先于状态块（pass 不能覆盖 reject），只有状态块不判完成，原始证据落 `self-check-raw.json` 而不是静默丢弃。
- **重启与卸载收口**：重启后把「running 但本进程无实例」的 run 收成 `failed`（跨进程租约保守跳过）；卸载即 abort 在飞引擎；调度器每条独立超时 + 有界并发；`session/event` 按归属过滤。
- **对外通道收紧**：`POST /runs/<id>/events` 只收观测类事件；回复通道 `tokenEnv` 只认 `FLOW_STUDIO_REPLY_TOKEN_*`、URL 只许 https 或回环，令牌在日志 / 错误里打码。

## 0.8.2 — 审计里剩下的 MAJOR（12 条，逐条有回归）

- **收尾封口**：写 `run/end` 前先封口，之后到达的 `session/event` 一律丢弃并计数——修掉「`run/end` 之后还有事件、`run.json.live` 被写回非 null」。
- **结论解析**：节点结论取「本 attempt 最近一条能解析出正式结论的消息」，不再取最后一条；闹钟的自审状态块不会顶掉同一回合更早的正式 verdict。打回上下文改印**原始 id**（模型照抄不再变成 `n_a:n_a:R1`）。
- **超时可配**：`start` / `POST /start` / `flow_start` 都接受 `runTimeoutMs` / `nodeTimeoutMs`（默认 2h / 20min），生效值写进 `run.json.limits`。
- **持久化**：`appendEvents` 先分配 seq 再写事件（崩溃不再产生重复 seq）、半行自动断开、启动用 `repairRunCounters` 修计数；run.json 的写路径加**跨进程** `meta.lock`（两个真子进程各写 40 条 → 磁盘 80 / 计数 80 / 重复 0）；写盘失败时错误文案与实际状态一致、不再留 `*.tmp-*`；租约过期就地 re-claim、0 字节锁可接管。
- **外部 executor 进程组**：`detached` + 整组 `SIGTERM→SIGKILL`，abort 后孙进程不再存活；结果带 `killScope` / `orphanWarning`。
- **worktree 生命周期**：残留路径自愈、失败不累积分支、locked 也能删、dirty/敏感文件给告警、空仓库能建（`baseCommit:null`）；新增 `GET /worktrees` / `POST /worktrees/prune` / `DELETE /runs/<id>/worktree`，**连 `flow/<runId>` 分支一起回收**（只删 `flow/` 前缀）。
- **调度**：同一发起会话的多个 run **合并成一次唤醒**（10 个 run 只发 1 条 followup），每会话 30 次/小时 + 最小间隔 120s，被限流的 run 保留 due 不丢；节点闹钟**重启后恢复**登记。
- **Host 面**：只读令牌 `FLOW_STUDIO_READ_TOKEN`（写请求 403）、`FLOW_STUDIO_ALLOW_CUSTOM_EXECUTOR` 主机开关（默认关，custom executor 会在宿主执行任意命令）、`FLOW_STUDIO_WORKSPACE_ROOTS` 白名单、`?light=1` 轻量投影（不解析事件，客户端 2s 轮询改用它）、`flow_watch runIds` 一次审多个 run、`/health` 报 `authMode` / `readOnly` / `customExecutor` / `limits`。
- **前端**：删流程二次确认 + 撤销（删成功才清草稿）、`sessionMode` 与 worktree 原因进运行详情、左栏与抽屉共用一份 runs 数据源、`Alt` 拖动绕过 4px 吸附（README 早就写了，现在真实现）。

## 0.9.0 — 状态机内核（XState v5）

把「转移决策」换成状态机内核（[08 状态机](../design/08-state-machine.md)）：

- **只换转移决策**：节点之间的推进从手写 `while + switch` 换成 XState v5 actor——分支、打回、重跑上限、取消、超时都变成机器里的转移与 guard。**节点执行、证据落盘、会话生命周期、supervision 全没动**：引擎仍用原来的 `_executeNode` / `_promptNodeSession` / `_runExternalNode` 跑节点，只把「下一个去哪」交给 actor。
- **XState v5 已 vendored 进仓**：`src/xstate-vendor.js` 是 esbuild 打成的单文件 ESM（`xstate@5.33.3`，只 bundle、未改逻辑），**不新增 npm 运行时依赖**；`node scripts/vendor-xstate.mjs` 可幂等重建，`--check` 校验已提交产物；MIT 许可与 tarball 溯源见 [THIRD-PARTY.md](../../THIRD-PARTY.md)。
- **事件流是唯一真相，快照只是缓存**：`run.json.machine = { version, snapshot, savedAt }` 供恢复加速（runstore 白名单 + 24 KiB 预算，超限裁剪并置 `machineTruncated`），任何冲突以 runlog 事件流为准（[08 §6](../design/08-state-machine.md)）。每次转移额外写一条 `machine/transition` **观测事件**（日志抽屉里的 `⇢`）——它只给人看、不参与决策，也不进冻结的 17 种基础事件。
- **逃生门**：`FLOW_STUDIO_FLOW_MACHINE=0` 回退 0.8.x 的旧主循环（行为逐字节保留，留一个发布周期）。
- **测试**：**21 个测试文件 / 759 组**全绿（不含 `test/build.test.mjs` 发布门禁）。
- **发布前的教训**：一条对 XState 内部对象做 `assert.equal` 的测试，在与预期不符时把宿主打成 22 GB OOM。修复与纪律见 [事故记录](../postmortem/2026-11-07-oom.md) 与 [CONTRIBUTING.md 的测试纪律](../../CONTRIBUTING.md#测试纪律)。

## 0.9.1 — 面板白屏修复 + 保存链兜底

修一个**真实的白屏缺陷**，并把「流程被写成空图」这一类事故从「不可逆」变成「拦得住 / 回得去」。这一版没有新功能。

- **白屏（真 bug）**：`runs` 快照可能比 `boot()` 的 `readFlow` 先到 —— 那时 `flow` 还是 null 而 `runForFlow` 已经非空，顶栏取 `flow.nodes` 直接抛 `Cannot read properties of null (reading 'nodes')`，整个 `main` 槽被判成崩溃、面板全白。改成 `flow ? flow.nodes : []`，并补一条**先红后绿**的 SSR 回归（用 `git worktree` 检出修复前的源码跑同一条用例，能稳定复现同一个 TypeError）。
- **保存链三道防线**（形状错、空图、缺字段各管一段）：
  - 客户端 `flowSavePayload()`：请求体必须真的带 `nodes` / `edges` 数组，列表摘要或半成品对象**不发请求**；
  - 客户端 `emptyGraphBlockReason()`：服务器上有节点 + 这次会话没做过结构编辑 + 却要保存空图 → 拦下并说明原因（用户真删光节点仍然能保存，空数组本身合法）；
  - Host `rejectIncompleteFlowBody()`：`PUT /flows/<id>` 的 `nodes` / `edges` 必须**存在且都是数组**，缺键或值不是数组（`nodes: null` / `nodes: 'nope'`）→ `400 FLOW_BODY_INCOMPLETE`。空数组仍然放行 —— 那是 0.7 拍板的宽松保存口径（画布自动保存的中间态必然非法，一律 200 + validation，严格口径只在启动 run 时）。
- **可回滚**：Host 每次覆盖前把磁盘上的旧版本另存一份 `flows/.history/<id>.v<version>.json`（每份流程保留最近 3 份，`.history` 不会出现在流程列表里）。备份先于主写盘：备份失败不影响本次保存；备份成功而主写盘失败时，旧版本已经落在 `.history` 里。同一个 `version` **只留第一次**备份（删除后再撤销重建会再次走到 v1，直接覆盖就把事故前的证据弄丢了）；`DELETE /flows/<id>` 成功后把该 id 的活动备份挪进 `.history/deleted/`（重名加时间戳），归档不参与 3 份轮转，需要时手动清理。
- **独立复核后又补的 6 条**（都属于保存链，之前只是一次人工排查没覆盖到）：
  - **保存在途串行化**：一次 `PUT` 慢于 700ms 去抖窗时，继续编辑会带着旧 `version` 再发一次，Host 只能判 409 —— 可实际没有任何第三方；点「运行」前的 `flushBeforeLeave` 也会撞上，`POST /runs` 根本发不出去。改成 `createSaveQueue()`：同一时刻最多一个 PUT 在飞，**出队时才取版本**，第二次请求带上前一次回写的新 `version`。
  - **保存态不再卡死**：保存期间又编辑过时，成功后回到 `dirty` 而不是停在 `saving`（自动保存的前置条件就是 `dirty`，停在那里等于永久停摆）。
  - **冲突按 flowId 隔离**：`conflictTarget()` 只认冲突发生时的快照；切到别的流程后点「用我的版本覆盖」不再对另一份流程发无条件写（之前会把它静默回退成自己手里的旧内容）。
  - **运行中禁止恢复草稿**：`restoreDraft()` 补上 `refuseWhenLocked()`，横幅里的「恢复」按钮在锁定时 `disabled` —— 之前运行中能把磁盘上的图整份换掉，与「运行中锁结构」不变式冲突。
  - **空图防线基线跟着服务器重算**：新增 `applyServerFlow()` 统一「从服务器读回的 flow」并重置基线；同一份流程被别处清空后重新打开，不会再把改名这类编辑误拦到必须刷新页面。
  - **停止入口不再丢失**：顶栏停止按钮只看该 run 是否在跑，不再要求当前打开着流程（流程被删掉后，那个 run 曾经在 UI 上停不掉）。
- **排查留痕（不是插件 bug，但值得记）**：本地那张「打开面板把标准研发流水线清空成 0 节点」的截图，根因在**我们自己的截图脚本**——`closeModals()` 会点所有可见文案为 `✕` 的按钮，而节点工具栏的删除按钮可见文案就是 `✕`（`aria-label` 才是「删除节点」），于是逐个 `deleteNode()` → `touch()` → 700ms 防抖自动保存把已经空了的图整份 PUT 回服务器。证据是 `touch()` 上的断点命中共 11 次、全部来自 `deleteNode`（11 = 3 + 8，正好是两条被点掉的流程各有多少节点），以及 PUT 的调用栈 `saveNow ← setTimeout(700)` / `flushBeforeLeave ← openFlow ← onOpen`。脚本已改成跳过画布内部的危险按钮；产品侧的三道防线管的是「图莫名丢了还写回去」，而 `deleteNode` 这条路径会被空图防线放行（它会把自己标记成「用户删过节点」），真正兜住它的是 `.history` 版本备份。
- **测试**：**21 个测试文件 / 772 组**全绿（含发布门禁 `test/build.test.mjs` 共 22 个文件 / 780 组）。本版新增 13 组：白屏回归、保存形状闸门、空图防线、缺字段/错类型 PUT 400、旧版本备份（保留 3 份与列表不串味）、备份不覆盖 + 删除归档、保存在途串行化、冲突按 flowId 隔离、`applyServerFlow` 基线重算、草稿横幅锁、停止入口；每一处都做过变异验证（把修复改回旧行为，对应用例必须变红）。

## 0.9.2 — 节点会话真的有工具（preset 组合挂载 + 打回门控 + 失败后重启）

这一版修的是**「流程跑起来了，但节点是个没有工具的傻子」**：节点会话创建时没有挂上 agent preset 组合，开发节点改不了代码、测试节点跑不了测试、主管派不出成员，于是方案节点只能凭上下文编文档，最后连「已写产物」都进不了仓库。同版把用户提的另外两条引擎侧需求（打回工具按结构门控、失败后重启在原会话续跑）一并做完。

- **根因（有宿主源码为证）**：`agents.create()` 只是把 `meta.agentPreset` 写进 session header（`@deepseek-ai/dsh-session` 的 `create` 分支），**挂载 preset 组合的唯一入口是 `setup` 回调**（`@deepseek-ai/dsh-agent-loop` 的 `initializeAgent`：`await setup?.(agent.ctx, agent)`）。旧实现只传 `meta` 不传 `setup`，于是节点会话拿到的是「没有 preset 的裸组合」——实测只有 `working_directory` / `memory_recall` / codegraph 三个工具。Web 侧自己走的是 `sessionController.composeAgent()`，它的 `setup` 才会 `presets.mount(agentCtx, resolvedId)`。
- **修法与解析顺序**：create 与 resume **两处**都传 `composition.setup`（resume 更容易漏，而它决定「打回重跑 / 重启续跑」的会话还有没有工具）。preset 生效值按 `node.agentPreset` > 本次 start 覆盖 > 引擎配置 > 流程级默认 > 兜底 `standard`；组合解析优先 `sessionController.composeAgent`（与 Web 同一条路径），其次 `agentPresets.resolve` + `setup` 里 `mount`，两个服务都没有时不传 `setup` 但留一条能诊断的 warn（不静默假装挂上）。
- **兜底可以降级、显式配置必须报错**：`standard` 是引擎自己塞的兜底，本 profile 没有它时退回宿主默认 preset（来源记 `default-fallback`，事件与 `run.json` 报实际 id）；节点 / 流程 / start 显式配的 preset 解析失败则 `400`，文案带节点、preset id 与可用 id 列表——配置错误不该被静默兜底。
- **生效值可见**：`node/start.data.agentPreset` / `agentPresetSource`（`node` / `start` / `engine` / `flow` / `default` / `default-fallback`）与 `run.json.agentPreset = {value, source}`。画布与详情页展示这三项属于 0.10 的界面工作，数据这一版已经吐出来了。
- **模型路由成对**：`agentOptions` 必须同时有 `provider` 与 `model`，缺的一项由宿主 `agentDefaultModel.currentSelection()` 补齐；两边都拿不到就在**创建之前** `503`（文案写明「宿主未提供 agentDefaultModel，且节点未配置 provider/model」），不再建一个注定在首轮 `preStep` 抛 `agent "…" has no provider/model` 的会话。节点自定义 `model` 时不移植宿主的 `reasoningEffort`（不同模型档位不可移植）。
- **打回工具按结构门控**：阶段节点主管多了一个模型工具 `flow_node_reject`（`reason` + 可选 `findings` / `rejectTarget`），语义等价于结构化结论 `verdict=reject`——它只把打回登记到本轮槽位，收口时并入既有结论，之后完全复用 `node/end rejected → selectRejectTarget → reject/trigger → 目标 attempt+1`，不新增事件 kind、不产生第二套状态。**只有当前流程里存在出向 `reject` 边的阶段节点才注册**；每次 attempt / 复用冷会话都按当前结构重算，结构加边就补挂、删边就用 disposer 撤掉，run 结束统一释放。
- **失败后重启**：`POST /runs/<runId>/restart` 与模型工具 `flow_restart` 共用 `runtime.restart`，语义是**新建一个续跑 run**而不是把旧 run 改回 running：只接受 `failed` / `aborted`；从旧事件流推导续跑起点（`run/end.failedNodeId` → 最后一条 `node/end failed` → 中止时未收口的 `node/start`）与已完成节点；新 run 继承旧 `sessions.json`（同一 node 复用原 sessionId，冷会话走 `agents.resume`）、跳过已完成节点并用它们的 summary 当上游上下文、旧 run 一个字不改；世系记在新 run 的 `run.json.restart`（`fromRunId` / `attempt` / `startNodeId` / `skippedNodeIds` / `inheritedNodeIds` / `oldReason`）。
- **验证时顺手挖出来的真 bug（不属于本次新增功能，但会毁掉可靠性）**：`npm test` 偶发在一条**旧**用例上红——`run.json.status` 是 `failed`，而事件流里明明是 `run/end done`。根因链：插件挂载时的启动恢复（`repairRunStates` → `sweepStaleRuns` → `sweepExpiredLeases`，fire-and-forget）会调 `cleanupTempFiles` **无条件**删除 run 目录里所有 `*.tmp-*`；它与另一个引擎正在进行的原子写并发时，会在 `write` 与 `rename` 之间把临时文件删掉，`rename` 拿到 `ENOENT`，`appendEvents` 的 catch 于是把**已经跑完**的 run 标成 `failed`（并写 `.error` 侧车）。两处修复：① 清理加**年龄闸门**（默认只删 60 秒之前的，临时文件生命周期是毫秒级）——这是根因修复；② `writeTempAtomic` 对 `ENOENT` **换名重试一次**（其它错误仍是存储故障，重试无意义）。两条都补了能红的回归（「刚写出来的临时文件不能被清理」+「临时文件被外部删掉一次后原子写仍然成功」）。
- **已知边界**：续跑 run 刻意走旧主循环（它支持显式起点），因此不写状态机快照；冷会话能否 `resume` 不预先逐个探测，失败时在节点处给带节点与 sessionId 的中文 `503`；preset 真实存在性由宿主 registry 判断，插件只做安全 id 校验，不维护会过期的白名单。
- **测试**：**23 个测试文件 / 802 组**全绿（含发布门禁 `test/build.test.mjs` 的 8 组 / 56 条断言；10 个功能套件显式计数合计 3998 条断言）。本版新增 `test/engine-restart.test.mjs`（5 组 / 55 条断言）与 `engine.test.mjs` 的 6 组（路由成对、preset 三来源、setup 挂载、只有 `agentPresets` 的 fallback、resume 带 setup、preset 不存在报 400），以及 `runstore.test.mjs` 的 2 组竞态回归。关键用例做过**红→绿**双向验证（把修复改回旧行为对应用例必红；`engine-restart` 的门控与 provider 成对两条在旧代码快照上确认变红）。

- **复核更正（0.12.2，2026-11-09）**：本节写的「优先 `sessionController.composeAgent`（与 Web 同一条路径）」不准确——本机 0.2.2 的 `sessionController` 服务只暴露 `resolveAgent`，`composeAgent` 属于内部 `ApiSessionAgentController`（`packages/api/session-controller/src/index.ts:179,268`），所以实际生效的一直是 `agentPresets.resolve` + `mount` 分支；该分支行为正确，0.9.2 以来的结论不受影响。细节见 [2026-11-09 事故记录](../postmortem/2026-11-09-cold-resume-preset.md)。

## 0.9.3 — 节点会话的预热轮（团队主管才派得出子 agent）

0.9.2 让节点会话真的挂上了 preset，但**实测发现工具面还是不够**：首轮精简插件（`@feiyueve/dsh-minimal-first-turn`）会把**新根会话的第一轮**工具面裁到最小对（`bash` + `str_replace_editor`），下一轮才恢复 preset 的完整清单。节点会话是程序化顶层会话，同样被裁——于是「主管 + 子 agent」节点在第一轮里根本看不到 `subagent`，派不出成员，父子结构形同虚设；开发 / 测试节点也没有 `glob` / `grep` / `todo_write` 可用。

- **修法**：新建节点会话建好后，引擎先发一条**不调工具的预热消息**（「只回 ok」），把被裁剪的第一轮消耗掉；正式任务从第二轮开始，拿到的是 preset 的完整工具面。预热失败（宿主报错 / abort）不阻断节点，只留一条 warn 并照常发正式任务——最坏退化成 0.9.1 的行为。
- **只在新建会话时预热**：打回重跑 / `restart` 复用的冷会话早已走过第一轮，不会再发（否则每次返工都多一轮小开销）。
- **可关**：`FLOW_STUDIO_WARMUP_FIRST_TURN=0` 或构造参数 `warmUpFirstTurn: false`；关掉后行为与 0.9.2 逐字节一致。
- **排障判据**：`node/start` 之后会话里会多出一条以「【引擎预热 · 本会话第 1 轮】」开头的 user 消息；引擎日志有「发送预热轮 / 预热轮完成」两行。
- **测试**：**23 个测试文件 / 804 组**全绿（`engine-restart` 5 组 / 55 条断言、`engine` 111 组 / 886 条断言；10 个功能套件显式计数合计 4015 条断言）。新增 2 组：预热轮先于正式任务且打回复用不重复预热、`warmUpFirstTurn:false` 时只有正式任务。另外把测试里的三个假宿主改成「真宿主口径」——预热轮（无 attempt/nonce 契约）只回 ok 并结束这一轮，`whenIdle()` 改成**每轮一个新的 promise**（旧假宿主一个 promise 用到底，加预热轮后必然卡住或抢跑）。

## 0.9.4 — 团队节点的收口（等成员 + 补要结论）

预热轮（0.9.3）让团队主管真的拿到了 `subagent`，容器测试台实测两名成员都写出了文件（`member-a.md` / `member-b.md`，含真实 `pwd` 输出）——但节点仍然失败：主管派完活就结束了自己的回合，回一句「两名成员仍在执行，继续等待回执」，本轮没有 JSON 结论；成员几秒后才写完。引擎按「没有正式结论」判结构不合格，成员白干。

- **修法（只在「本轮没有正式结论」且节点是 `team` 时触发，不放宽判定）**：① 先**等**已观测到的成员会话不再是 `working`（有界，`FLOW_STUDIO_TEAM_WAIT_MS` 默认 120s、2s 轮询；成员会话从宿主注册表消失视为结束）；② 再**要**一次结论：发一条带同一 attempt/nonce 契约的补充指令，要求主管用规定格式给出结论。补要失败或仍无结论 → 按原语义报结构不合格并走既有重试/打回通道。
- **为什么不用「把 spawn 改成阻塞」**：那是宿主 `subagent` 工具的能力，插件不能改；而且「派完不阻塞」本来就是团队的正常形态，缺的是收口时机。
- **测试**：**23 个测试文件 / 805 组**全绿（`engine` 112 组 / 896 条断言）。新增 1 组端到端：主管主回合只回「仍在等待」、成员状态先 `working` 后 `idle` → 引擎等完补要一次结论、`node/end passed`、`summary` 取主管自己的话；顺带断言一轮跑下来正好三条消息（预热 + 主回合 + 收口指令）。
- **已知边界**：成员若长时间不结束（> 上限），补要结论时主管只能如实写「仍在执行」，判定仍可能是 reject —— 这是正确结果，不是引擎瞎猜。

## 0.9.5 — 补要结论后的合并块兜底（真机跑挂一次之后补的）

容器里 6 阶段流水线跑到第 4 阶段（`n_dev` 开发）时整轮 `failed`，事件流里节点其实已经交出了完整结论——`npm test` 842 组、`build` 通过、证据齐全——但被引擎判成「没有可解析的正式 JSON 结论」。

- **根因**：主管补要结论后交的是**一个对象同时含状态与结论**：`{"state":"done","progress":100,"blockers":[],"verdict":"pass","summary":…,"artifacts":[…]}`。`parseAssistantStructured` 的判定是「有 `state` 键 = 自审状态块」，于是整块被丢；自审提前完成（`_maybeCompleteSelfCheck` 也要它解析出正式结论）与收口解析两条路径都拿不到结论 → `StructuredOutputError` + 重试一次，白跑两轮。
- **修法（只在「已经补要过一次结论」的收口路径上放宽，默认严格语义不变）**：`parseAssistantStructured` 新增 `allowMergedConclusion`（默认 `false`）；`_settleNodeTurn` 在补要结论后仍解析不到时，用该选项再看一次。放宽的边界是硬的：只认 `state === 'done'` 且**带结论证据**（`artifacts` / `findings` / `acceptance` / `tests` / `checks` 至少一个）的合并块；`state:'working'` 里夹 `verdict` 仍然不算结论（不许没干完就报 pass）；`attempt` / `nonce` 照样要匹配；同一条回复里若有纯正式结论，仍然优先纯结论。命中时留一条 warn 便于排障。
- **为什么不在解析器里无条件认合并块**：现有用例明确锁死「只有状态块（哪怕自带 `verdict:pass`、带全套证据）不得判完成」——那是防止「进度块冒充结论」的假绿闸门。放宽只放在「已经明确要过一次结论、模型仍这样交」的补偿路径上，两种语义各守一边。
- **测试**：**23 个测试文件 / 806 组**全绿（`engine` 113 组 / 906 条断言，+1 组 / +10 条）。新增一组端到端（团队节点补要结论后回合并块 → `node/end passed`、`final.status done`、零失败事件、日志有合并块 warn）+ 5 条解析器断言（严格模式仍拒合并块、放宽模式认「完成态 + 证据」、放宽模式仍拒 in-progress 与无证据、凭证不符仍丢、同回复内纯结论优先）。做了**红→绿**双向验证：把 `src/engine.js` 改回旧行为，端到端那条直接红成 `'failed' !== 'done'`（就是真机症状），解析器断言红成 `null`。
- **已知边界**：合并块里若没有证据字段（只有 `verdict` + 摘要），仍然不算结论——那种形状与状态块无法区分，宁可让节点按原语义失败并在界面上暴露，也不赌一次假绿。

## 0.10.0 — 九条改进落地（这一版是插件自己的流水线在容器里开发出来的）

0.9.x 把引擎修到「节点能干活」，0.10 修的是**用户看得见的那一层**：卡片上的三个按钮点不到、指标条永远少半行、会话跳不过去、preset 与工具清单不可见、skills 只能翻复选列表、失败后只能在终端里 restart。九条诉求按需求 → 方案 → 结构 → 开发 → 测试 → 审查六阶段做下来，3 轮节点内打回返工（`n_dev` attempt 3、`n_test` attempt 3、`n_review` attempt 2），产物与裁决见 `docs/plan/0.10-*.md`。

- **R1 模型路由同源成对（P0）**：新增纯函数 `resolveModelRoute`，create 与 resume 共用一个解析器，来源只有 `node` / `session` / `host` 三种且必须**同源**——节点只配 `provider` 时不再拿宿主的 `model` 拼一对（旧实现允许 `openai + deepseek-chat`，现有用例还把它断言成合法，本轮改掉）；缺一半在**创建前** 503 并写明补哪一个字段；`sessions.json` 条目新增可选 `agentOptions`，冷会话 resume 带的还是这一对。resume 之后读 `agent.model.current()` 核对实际模型，不一致只 `warn` 不失败（宿主优先级是「会话已记录 > 上次请求 > agentOptions」，插件改不了已记录的 selection，就不假装能改）。
- **R2 三键不裁切（P1）**：`.fs-node` 的 `overflow` 由 `hidden` 改 `visible`——整卡裁剪本来只为圆角服务，卡片内部各元素（标题/摘要省略号、tags/members）各自已有裁剪。卡片尺寸仍是 208×96（主从 208×116），悬浮工具条 3×22px 完整落在卡外。真实浏览器实测：`elementFromPoint` 命中按钮自身、祖先链无裁剪、hover 与 `:focus-within` 均可见、Tab+Enter 可点。
- **R3 指标横条（P1）**：`.fs-log-stats` 由写死 `height:46px` 改 `min-height:58px; height:auto`，三行（值 / 标签 / 副说明）不再被裁；展开抽屉默认高度 200→340px，事件区实测 151px / 可见 3 行；200px 最小档 7 个 hint 一个不裁。
- **R4 跳会话详情（P1）**：`ctx.get('uiWorkspace')` **懒取**（不写进 `inject`：必需服务缺失会让整块面板停在 PENDING），`openSession(sessionId)` 经 slot props 注入；节点详情「打开节点会话」与 run 头部「打开发起会话」两个入口，拿不到服务时降级成复制 id 并说明原因，不假装能跳。
- **R5 preset 与来源可见（P2）**：`normalizeRun` 之前显式映射把 `sessions` 与 `agentPreset` 丢了（UI 就算写也拿不到），本轮先在归一化层补两个字段（坏形状降级 `null`）再渲染；节点详情显示「preset：<id>（来源：节点配置 / 流程 / 引擎 / 宿主兜底…）」，run 列表行也带 preset；只读展示，编辑入口留 0.11。
- **R6 可用工具清单（P1）**：新增 `node/tools` 事件（不塞 `node/start`——`node/start` 早于 `agents.create`，创建前根本拿不到工具面），在 `_syncNodeRejectTool` **之后**采集，上限 64 个 × 64 字符、单条事件 ≤8KB；客户端分「可用工具」与「最近工具调用」两区，`tools.definitions` 抛错 / 无定义 / 被裁剪三条降级路径都留 warn，不静默空白。
- **R7 skills 下拉多选（P2）**：检查器改成**内联 combobox**（不用浮层——检查器是滚动容器，浮层必被裁），保留搜索、chips、12 个上限与键盘契约（↑↓ / Enter / Space / Esc），并修掉「隐藏项仍被 Space 选中」的守卫 bug。
- **R8 失败后重启 UI（P1）**：动作条新增「重启」；顺序不可反——**先 `flushBeforeLeave` 保存流程**，warning 非空就中止（一次 restart 都不发），只有 flush 成功才 `POST /runs/<id>/restart`（否则 Host 读到磁盘上的旧结构，A8.3「加边→重启→补挂工具」会假绿）；服务端同时加进程内互斥与「已有续跑 run → 400」（旧 run 不能被两个新 run 同时续）；错误码按 400/403/404/409/503 给可读文案。
- **R9 打回旁路（P1）**：无出向打回边的节点仍不挂 `flow_node_reject`；但主管若用文本 `verdict=reject` 打回，旧实现会直接判 run 失败且不说原因——本轮**保留失败**（把打回降级成 pass 是正确性风险），只把文案改成可行动（「补一条 reject 边，或用重启在原会话续跑」）并在 `node/end` 写 `extra.rejectBypass='no-edge'`。
- **验证**：`npm test` **EXIT 0**，23 个 `.test.mjs` / **855 组**（`engine` 127 组 / 1042 条断言、`engine-restart` 9 / 88、`render` 99、`logdrawer` 62 / 937；发布门禁 8 / 56，功能套件显式计数合计 3986 条）；`npm run build` **EXIT 0**（`lib/client.js` 472,988 B < 上限 524,288），`verify-build` **EXIT 0**；`docs/design/` 零 diff；无新增源码文件与依赖；未 push / 未 publish / 未重启任何服务（容器内的 dev 实例除外，那是测试环境）。
- **真实浏览器证据**（测试节点在容器内解包 Chromium + puppeteer-core 量测，夹具不入库）：R2 三键 22×22 可命中；R3 指标条 67px 外框 / 58 内容盒、7 个 stat 三行齐、事件区 151px/3 行；R4 两个入口点击各调用一次、参数精确；R5 节点详情 `preset：ptc（来源：节点配置）`；R7 收起/展开/键盘/上限。
- **已知边界（不阻塞，记录在案）**：① skills 搜索框在已有 active 时仍把 Space 当选择键（设计锁定，若要空格当搜索词需改契约）；② `page.js` 里有两处 340/200 的旧注释与结构文档不一致；③ `openSession` 不做归属校验、restart 错误横幅跨 run 残留等 F13–F17 观察项按 P2 accepted；④ 「start 失败留下 pending 子 run，会挡住旧 run 的 restart」是新暴露的 E13，发布补丁或 0.11 处理。
- **怎么产出的**：这一版由 flow-studio 自己的六阶段流水线在容器里跑出来（`r-mw67vqpf-okns` 死在 `n_dev` → 修引擎发 0.9.5 → `restart` 续跑成 `r-mw6aiqyp-25z6` → done）。中途那次死在 `n_dev` 不是流程问题，而是 0.9.5 修的那个「状态块 + 结论合并」解析缺口——同一份代码先把自己踩的坑修掉，再跑完剩下的阶段。

## 0.11.0 — 加固：租约世代、runtime 竞态、证据授信与脱敏（三轮开发 + 两轮独立复核）

这一版不改用户可见功能面（九条 UI 改进在 0.10.0 已经交付），修的是**跑起来才暴露的信任问题**：并发接管会不会双写、报告副本会不会把凭据带进公开目录、质量结论会不会拿模型自报刷绿。做法是三条平行的加固线，落完后由独立复核做对抗性验收——第一轮判 **REJECT**（修复自身带出三个新阻断项），修完再做第二轮。

- **R1 租约原子性（`src/runstore.js`）**：`renewLease` / `releaseLease` 与 `claimLease` 共用同一把 `meta.lock`，`ownerId` + `epoch` 对账，`finalizeEpoch` 的幂等收口也进同一锁事务。任一环节不在锁内，两个进程就能同时认为自己是写者。
- **R2 runtime 竞态（`src/runtime.js`）**：失权清理先核对世代再落盘；工作区配额键改 `realpath`（软链能绕配额）；`start()` 同步预占 runId（避免两个 start 同时通过预检）；`dispose()` 等进程**真的**终止再还槽。
- **R3 证据授信与脱敏（`src/host-check.js` / `src/runlog.js` / `src/engine.js`）**：公开报告副本**先脱敏再算 hash**（顺序反了会得到源文件 hash，验证器判不符）；legacy 事件不计权威；混合证据（host + 模型自报）不再免于降权。
- **N1 修「越没证据越绿」**：原先 legacy-only 事件集（权威覆盖 0%）仍给「优：首轮通过」并渲绿，而同等覆盖度带 `provenance:'model-claim'` 的新 run 反被降 `unknown`。现在 pass 档要求**权威覆盖 100%**（`QUALITY_PASS_MIN_AUTHORITY_COVERAGE = 1`）：只要还有应验条目未被宿主权威覆盖，就不能借别的条目点亮整条 run；客户端 `conclusionOf` 同口径兜底，不再渲绿。
- **N2 修租约兼容分支的 ABA**：新 owner 接管后，旧调用方只要不传 `ownerId`（同一进程内 pid@host 相同）就能续租、甚至删掉新 owner 的租约。现在兼容回退**只在 `run.json` 还没有 `execution` 字段的 0.10 旧 run 上**生效；持久世代一旦存在，缺 `ownerId` 一律 409。start 失败收尾也改成带 claim 的同一份 `{ownerId, leaseEpoch}` 释放——否则会留下一个谁也接管不了的 `lock.json`。
- **N3 修脱敏面的两个漏**：① 非 UTF-8 / 二进制报告的公开副本原先**原样复制**（canary 实存）；现在按 latin1 1:1 映射后只跑**高置信**规则（Bearer/Basic/Token、`sk-`、`--secret 标志位`、`key:value`），命中段替换、未命中字节逐字节保留，因此不含凭据的二进制报告 sha256 与长度不变、验证器照常通过；**不**在不可判读字节上跑 ≥32 长度启发式（PDF/图片/长 hex 头会假阳性，正好破坏「非命中字节不变」这个证据前提）。结果新增 `reportOpaque`。② `--token <值>` 这类**空格 / 引号分隔**的凭据原先任何规则都不认，会原样进 `commandSummary`；现在 engine 的摘要规则改为委托 `host-check.redactSensitiveText`（同一份规则，不再各自维护副本），`process-output.redactText` 复用同一模式常量。
- **第二轮复核追加修复（N6~N10）**：第一轮修完后再做一次对抗性复核，又查出五处——① `--api-key` / `--password` / `--secret` 的标志位规则要求前导是文本分隔符，二进制记录里前面是 NUL 或长度前缀时**原样泄漏**（N6）；② 值字符类没排除 NUL，`token=<canary>\0tail` 会把 `\0tail` 一起吞掉、公开副本丢字节（N7，这条是靠把断言从「首两字节」改成**逐字节精确相等**才暴露的）；③ `reportOpaque` 只进了嵌套对象，被 `boundExtra` 丢掉、私有登记白名单也没收（N8）；④ `process-output` 只认 Bearer，`Authorization: Basic <base64>` 抹掉 scheme 却留下凭据（N9）；⑤ `execution` 被抹掉但 `lock.json` 仍是 0.11 形状时，无 ownerId 的 pid@host 仍可续租（N10）。五处全部修掉并各自做了红→绿：标志位前导判据改成「前一字符不是 `[A-Za-z0-9_-]`」、值按文本/二进制两套字符类分别排除 NUL/控制字节（二进制再排高位字节，值只吃可打印 ASCII）；`reportOpaque` 同时进事件扁平键与私有登记；`Bearer|Basic|Token` 三方案同口径；兼容回退要求 `lock.json` 也没有 ownerId/epoch。
- **行为变化（升级前请读）**：
  1. **没有 `ownerId` 的 `renewLease` / `releaseLease` 调用会 409**——仅当目标 run 已有 `execution`（即 0.11 写过世代）。0.10 旧 run 仍可用 pid@host 兼容释放。仓库内生产调用点已全部合规。
  2. **质量结论的「优 / 良」在真实 run 上不可达**（见下方 G-E）：引擎对 `acceptance/verdict`、`test/report` 一律写 `provenance:'model-claim'`，只有宿主检查的 `check/form` 会写 `producer/authority:'host'`。所以即使给节点配了宿主检查，三项里仍有两项是自报 ⇒ `claimedPassed ≥ 2` ⇒ `state=unknown`，文案是「证据不足：N 条 claimed 通过未获宿主独立验证」。这不是坏了，是**不再拿模型自报刷绿**；要让 run 能绿需要 0.12 落「authoritative peer」（产物存在性 + sha256 绑定计入权威）。
- **验证**：`npm test` **EXIT 0**，**27 个 `.test.mjs` / 991 组**（发布门禁 8 组 / 62 条断言 + 26 个功能套件 983 组；12 个套件显式计数，合计 4434 条断言）；`npm run build` **EXIT 0**（`src ↔ lib` 20 个 Host 模块逐字节一致、37 个打包输入、`lib/client.js` 481,892 B < 上限 524,288）；`node scripts/verify-build.mjs` **EXIT 0**。十处修复全部做了红→绿双向验证（把产品代码改回旧行为，新用例必须红；含一条「二进制报告含 64 位 hex 串不得被误伤」的反向锁）。
- **已知残留（记录在案，不阻塞）**：① `finalizeEpoch` 在持锁期间要扫全量事件，而 `META_LOCK_TTL_MS` 只有 10s——超大 run + 慢盘上可能被别的进程按「陈旧锁」接管；② 没有世代信息的旧 Engine 走到迟到清理时，fence 会退化成 `{}`，`supervision.enabled=false` 可能无 fence 落盘；③ `appendEvents` 完全不传 fence 的写法仍被接受（与直接改 `run.json` 同信任域）；④ 二进制副本按设计不跑调用方自定义 redact，只覆盖内置高置信形态；无 recognized 形态的裸随机秘密仍不可检测（与方案 §5 的承诺一致）；⑤ **不覆盖 UTF-16 编码的凭据**（含 PowerShell 默认输出形态）——有 BOM 时走二进制路径、无 BOM 时因 NUL 合法走文本路径，两种都不识别 `--api-key` 这类标志位，第三轮复核实测副本与源逐字节相同；⑥ 标志位前紧邻 `[A-Za-z0-9_-]`（如 `deadbeef--api-key <值>`）有意不命中，避免把词中片段误当参数（`=` 形态仍由 key:value 规则兜住）；⑦ 认证方案的值只吃 token-safe ASCII，`Authorization: Basic 中文密码` 这类非 ASCII 凭据三处都不认（既有缺口，非本轮引入）。
- **12 条缺口评估里未纳入本版的**：G-A（无人值守节点卡审批无超时）/ G-C（打回上限触发即判 run failed，无「再给一轮」）/ G-D（结论派生数字不自洽判死整条 run）/ G-E（质量结论不可达）— 均记在 [0.11 功能缺口评估](../plan/0.11-功能缺口评估.md)，列为 0.12 候选。

## 0.11.1 — 去掉消息字数限制（长正文落盘 + 显式指针）、节点会话终于有标题

这一版修两个用户直接看得见的问题，都不改流程结构。

- **消息字数限制去掉**。原先一条消息从入口到模型要过三道静默截断：入库 4000 字、写事件 2000 字、进提示词 1200 字。实测症状是：投 1740 字的业务描述，节点只看到约 1190 字，**而且它不知道自己被截断了**——一条设计 run 因此把「原文不完整」当打回理由，整条 run 被判 failed。
  现在：≤1200 字全文进提示词；**超过 1200 字把全文落盘**到 `<runDir>/inbox/<messageId>.md`（目录 0700 / 文件 0600，原子写），事件、`messages.jsonl`、`run.json.input` 只放 1200 字头部 + `bodyPath` + `bodyChars`，提示词里给出**绝对路径 + 全文字数**并要求「必须先用 read 工具读完全文再作答」。事件体积因此不增长（8 KB 上限照旧）。
  硬上限 `MESSAGE_BODY_HARD_MAX_CHARS = 200000` 字，超过**直接返回可读错误**（含实际字数与上限），不再静默截断。
  同口径放开三处：`flow_send_message` / `flow_reply` 工具入口（原 4000 上限）、出站回复正文（原本超过 4000 静默截断，现在投递用全文、只有审计事件按 2000 字留痕）。
  落盘失败不吞消息：保留头部 + warn + 返回体 `bodySpillError` 可诊断。
- **节点会话有标题了**。DSH 的会话标题只从**人类 `user/message`** 派生（内置回退与 provider 都如此），而 flow-studio 注入节点的是 `source.kind='flow-studio'` 的消息，永远不符合条件 ⇒ 会话列表里全是「未命名」。现在引擎在 `agents.create` 成功后调用 `sessionTitle.rename(session, '流程名 · 节点标题')` 显式命名（截 40 码点）；服务缺失 / 会话不活 / 字段超限一律只 warn，绝不影响节点执行。
- **验证**：`npm test` **EXIT 0**，**28 个 `.test.mjs` / 998 组**（发布门禁 8 组 / 62 条断言 + 27 个功能套件 990 组；12 个套件显式计数，合计 4437 条断言）；`npm run build` EXIT 0；`node scripts/verify-build.mjs` EXIT 0。新增 `test/inbox-spill.test.mjs` 7 组（长消息全量可达 / 短消息不变 / 硬上限可读报错 / 落盘失败降级 / 旧数据兼容 / 活会话注入带指针 / 事件白名单与跨模块常量同值），并做了红→绿：在旧代码上投 5000 字消息会被截到 4000/2000/1200 且提示词无指针。
- **已知残留**：① 没有 `bodyPath` 的**旧消息**（>1200 字，磁盘上本来就没有全文）在提示词里仍按 1200 字显示；② 整段提示词预算 `PROMPT_MAX_CHARS = 8000` 仍在——极端长的上游产物叠加多条长消息时，「外部消息」段可能被整体压缩（既有逻辑，本次未改）；③ `PROMPT_INBOX_MAX_MESSAGES = 5`，同一节点一次最多带 5 条外部消息；④ UTF-16/非 UTF-8 编码的超长消息按字符数计（不按字节），极端情况下 200000 字可能让单条事件逼近 8 KB 上限——但落盘路径已把正文移出事件，只有 ≤1200 字头部进事件。

## 0.11.2 — 节点卡放大（232×108）+ 画布卡上直接跳节点会话

这一版动的是**设计层被冻结过的那组几何**，外加一个一直只在抽屉里存在的入口。

- **节点卡放大，冻结条款解冻**。0.10 曾把「节点卡 208×96（主从 116）」写成硬约束，理由是航道坐标与成员行几何全建在这组数上、改宽会连锁作废。0.11 之前已经把打回线矩形、世界边界、命中测试全部改成从 `NODE_W` / `NODE_H` / `nodeHeight()` 派生，冻结的技术前提已经消失，解冻成本降到「改常量 + 同步断言」。新值：标准卡 **232×108**、主从卡 **232×128**（仍是 `NODE_H + 20` 表达式）、标题 **15px/24px**、主干列距 **284**、8 列世界宽 **2220**；出厂模板 8 列的 x 改为 284 步进（40 / 324 / 608 / 892 / 1176 / 1460 / 1744 / 2028），保证 `worldBounds().w` 与 `EIGHT_COL_WORLD_W` 同源。决策与推导见 [0.11.2 节点卡放大-需求](../plan/0.11.2-节点卡放大-需求.md)，[DESIGN.md](../DESIGN.md) §6 裁决表与总览数学已同步；`docs/design/` 分册作为冻结产物不回写。
- **LOD 边界按「渲染后文字实际大小不变」重算**：旧 far/mid 边界 0.45 / 0.6 × 14px = 6.3px / 8.4px；新字号 15px 解同一组像素得 `z = 0.42` / `0.56`。效果是升级后同一缩放值**可能**从精简档跳到紧凑档，这是预期结果，不是回归。
- **画布节点卡上直接「打开会话」**。此前跳会话只在运行日志抽屉里（节点详情 / 事件 ref / run 头）。现在节点卡 hover 工具条多一个按钮，**仅当当前活动 run 的 `run.sessions[nodeId]` 有该节点会话时渲染**——没有会话就完全不出现，不留「点了没反应」的入口。点击链路仍走宿主注入的 `workspace.openSession`（与抽屉同一条），按钮在 `pointerdown` / `click` / `dblclick` 上截断冒泡以免触发拖拽或双击进抽屉，带 `aria-label` / `title` 与 focus ring；抽屉那套零改动。
- **行为变化（升级前请读）**：
  1. **已保存流程的节点坐标不迁移**：卡宽 232 而旧流程仍按 260 步进排布，列间视觉间隙从 52px 收窄到 28px。渲染、命中与连线都正确，只是密集流程的连线呼吸区更紧。不静默改写用户数据是刻意的取舍。
  2. **全览 fit 变小**：8 列世界宽 2028 → 2220，同样视口下 fit 约为原来的 0.91 倍（例如 880px 画布上 38.7% → 35.3%）。
  3. 带会话的节点工具条从 3 键变 4 键（外框 76×28 → 100×28），仍从右边贴齐向左展开。
- **验证**：`npm test` **EXIT 0**，**28 个 `.test.mjs` / 1000 组**（发布门禁 8 组 / 62 条断言 + 27 个功能套件 992 组；13 个文件显式计数，合计 4655 条断言）；`npm run build` **EXIT 0**（`src ↔ lib` 20 个 Host 模块逐字节一致、37 个打包输入、`lib/client.js` 483,652 B < 上限 524,288）；`node scripts/verify-build.mjs` **EXIT 0**。`geometry.test.mjs` 7 组、`render.test.mjs` 102 组随新常量同步，未删除任何断言、未把数值断言放宽成 `assert.ok()`；新增会话入口的 4 类断言（有会话出现 / 无会话不出现 / 回调收到正确的节点与会话 id / `aria-label`）与页面级 `openSessionForNode` 的过期 id、缺回调降级。
- **已知残留**：① 本次无浏览器 E2E 重测热区——点击、键盘 Enter/空格、拖拽与双击隔离由 SSR 结构断言 + 纯函数断言证明，真实 `getBoundingClientRect` 未复测（三键仍是 22×22、`top:-14px` 未动，0.10 的浏览器结论继续参考）；② `canvas.js` 聚焦缩放的下限仍为 60%，高于新 near 边界 56%，所以聚焦一定落在完整档——但它不属于 LOD 阈值，日后若再调字号需一并复核；③ 测试计数的口径修正：`executor.test.mjs` 用「32 组通过，218 条断言」的全角逗号格式，此前只匹配全角括号的汇总一直漏计这 218 条，本版起合计口径含它（旧版本记录的 4437 条是漏计后的数字，不是断言的增减）。

## 0.12.0 — 流程产物从「一份大 JSON」改成「一个目录」

这一版改的是**流程怎么被写出来**，不是流程怎么跑。

- **问题（实测）**：让模型一次手写整份流程 JSON 会崩在三处。元流程自身 9 节点 / 13 边的 flow JSON 是 **44,947 字节**（UTF-8，其中 `task` 正文合计 13,633 字）；设计 run 的节点⑦还要求模型在已经写了 **63,568 字节**规格正文之后，再把这一万多字**重新编码**进 JSON。结果是 ① 评审节点审的是 Markdown、交付的是 JSON，**同一模型无机械校验的重述必然漂移**（id 改名、措辞压缩、成员合并）；② 结构错误只在**导入时**才暴露，跑了两小时、`maxRounds` 用尽，最后一个逗号就让交付物作废；③ 4.5 万字节单文件不可 diff，改一个节点要整份重抄。那次 run 实际产出的 `flow-*.json` 是 **0 个**。
- **改成目录化**（`src/flowdir.js`）：一份流程 = 一个目录，
  ```
  <dir>/flow.json                 # name / description / nodeOrder / edges
  <dir>/nodes/<id>.json           # 单节点结构，不含 task
  <dir>/nodes/<id>.task.md        # task 正文（Markdown，唯一的大块）
  ```
  最大的单文件从 4.5 万字节降到**每节点一两千字节**；`task` 不再是转义后的 JSON 字符串，而是能直接读、直接 diff 的 Markdown。9 节点流程反编译后是 **19 个文件 / 43,542 字节**——总体积几乎不变，变的是**形状**：可逐文件审、可只改一个节点、可只重跑一段。
- **校验仍然只有一份**：`compileFlowFiles` 组装后直接走 `normalizeFlow` + `validateFlow`，**不另写结构校验**；错误带 `{code, path, field?, message}`，按**文件与字段**定位（`missing-manifest` / `bad-manifest-json` / `bad-node-json` / `missing-node` / `unlisted-node` / `missing-task` / `task-duplicated` / `unknown-file` / `unsafe-path` / `invalid-flow`）。这是刻意不做「自定义 Markdown 方言」的原因：本仓零运行时依赖，自写解析器等于造第二套判据，与 `validateFlow` 必然漂移。
- **宿主入口**：`POST /flows/import-dir`（目录 → **新流程**，不覆盖已有）、`POST /flows/<id>/export-dir`（流程 → 目录，拒绝覆盖别人的目录 → 409 `FLOW_DIR_REFUSED`）；模型工具 `flow_compile`（编译，`save:true` 才入库）与 `flow_decompile`（导出）。`dir` 一律要求绝对路径；显式 `name` 覆盖目录里的流程名。目录是**编辑期真源**，`flows/<id>.json` 仍是**运行期真源**，两者不做自动双向同步——靠「导入生成新 id」避免两个真相源互相覆盖。
- **往返是硬门禁**：`compile(decompile(flow))` 与原 flow 深等；`defaultFlow()` 与含 team / skills / check / 中文 task 的流程都要过；另加逐字节确定性与「不 mutate 输入」。实测 5 个真实存量流程（含 9 节点元流程）往返**全部深等**。
- **元流程已同步**：⑦「落地规格」从「手写 `flow-<slug>.json`」改成「写目录 + 调 `flow_compile` 把 `errors[]` 清零再交付」，④ 的硬约束块同步改为目录布局（`flow-8c7a00530c` version 2→3，`validateFlow` 无 error / 无 warning，旧文案零残留）。
- **验证**：`npm test` **EXIT 0**，**29 个 `.test.mjs` / 1,035 组**（发布门禁 8 组 / 64 条断言 + 28 个功能套件 1,027 组；12 个套件显式计数，合计 4,647 条断言；另有 `executor.test.mjs` 用全角逗号格式的 218 条）；`npm run build` **EXIT 0**（`src ↔ lib` 21 个 Host 模块逐字节一致、37 个打包输入、`lib/client.js` 483,652 B < 上限 524,288）；`node scripts/verify-build.mjs` **EXIT 0**。新增 `test/flowdir.test.mjs` 20 组（1,223 行实现 / 561 行测试）。
- **兼容性（升级前请读）**：存量 `flows/*.json` **一个字节不动**；`POST/PUT /flows` 的语义与校验**完全不变**，目录化是**附加路径**。要迁一份老流程：`flow_decompile` 导出目录 → 改 → `flow_compile` 存成**新流程**（会产生新 id，旧流程不受影响）。
- **已知边界**：① `compileFlowFiles` 返回「文件里写了什么就是什么」的组装结果、不补默认值，入库前必须再走 `normalizeFlow`（宿主两处入口已做）——直接拿它当已归一对象用会缺 `executor` / `maxRounds` 这类默认字段；② 只报「节点 / 连线被 `normalizeFlow` 丢弃」这类结构损失，**不报值级收敛**（标题超长被截断、非法 `edge.kind` 被改成 `next`、`x/y` 非有限数被改 80）；③ 非 JSON 类型经往返会变形（`undefined` 丢失、`NaN`→`null`、`Date`→字符串），往返契约只覆盖 JSON 模型内的流程；④ 覆盖已有产物目录是「旧目录改名 → 新目录 rename → 删备份」两步，两步之间崩溃会在父目录留下 `.flow.old-*` / `.flow.tmp-*`（正常路径会删净）。
- **没做**（0.12 第二批）：git hook 驱动设计期门禁（`pre-commit` 跑同一个 `flow_compile`）与设计 run 默认开 worktree。**不会**拿 git hook 驱动 run 生命周期——run 事件有自己的 JSONL 契约，hook 是同步阻塞且在无仓库 / `custom` executor 场景直接失效。

## 0.12.1 — 冷恢复必须挂 preset 组合

这一版修的是**恢复**，不是运行：唤醒一个冷会话时漏了 `setup`，那个会话就等于被换了一套工具面。

- **事故（2026-11-09 13:53，实测）**：supervision 唤醒一个冷会话，`agents.resume({ resumeSessionId })` 不带 `setup`，而宿主只在 `agents.create()` / `agents.resume()` 的 `setup` 回调里挂 agent preset 组合（`meta.agentPreset` / `header.agentPreset` 只写持久化，**不挂组合**，且不传 `setup` 不报错）。恢复出来的 agent 只剩宿主层插件工具：`request/header` 从 **68 → 37**，紧接着 `tool-registry` 一次推 **31 条 `tool-removal`**，模型此后每轮调 `bash` 都是 `Error: unknown tool "bash"`。详见 [事故记录](../postmortem/2026-11-09-cold-resume-preset.md)。
- **修复**：新增 `src/resume.js`，三处宿主侧冷路径（`wakeRun()` 的 supervision 唤醒、节点自检闹钟、`inbox.js` 的 `deliverToAgentSession`）统一走 `resumeCold(ctx, agents, sessionId, { agentOptions, log })`。`setup` 内部按「日志最后一条 `agent-preset/selected` > `header.agentPreset` > 宿主默认」求该会话**自己的** preset，再用 `agentPresets.resolve(id)` + `mount(agentCtx, resolvedId)` 挂组合（0.12.2 复核确认：这台宿主上 `sessionController` 服务只暴露 `resolveAgent`，`composeAgent` 属于内部控制器，所以 0.12.1 写的那条「优先 composeAgent」分支从不执行；实际生效的就是这条，它与宿主 `composeAgent` 的 setup 实现同构）。
- **降级不致命**：记录的 preset 已不存在 / 挂载抛错 → warn 后改挂宿主默认；再失败 → 再 warn 并让本次 resume 照常完成。挂组合失败不能把唤醒或投递整条打死（宿主里 `setup` 抛错会让整个 resume 失败）。
- **节点主管会话那条路早就修过**（0.9.2 的 `engine.js` 的 `_resolveAgentComposition`），这版补的是宿主侧三处；`scripts/build.mjs` 的 `HOST_MODULES` 同步加 `resume.js`。
- **验证**：`npm test` EXIT 0（30 个 `.test.mjs`），新增 `test/resume-setup.test.mjs` 8 组 / 42 条断言——冷路径必传 `setup`、setup 挂的是会话自己的 preset、`agent-preset/selected` 优先于 header、preset 挂载失败退默认且有 warn、无 preset 服务仍能 resume、活会话不 resume。变异验证：把 `resumeCold` 改成永不带 `setup`，新用例立刻红。
- **已知边界**：① 组合挂到一半失败只会 warn 继续，会话可能是半套工具面（不崩，可从 warn 与 `tool-registry` 观察）；② 宿主自带的 ACP / headless / SDK 三条 resume 路径都有 `setup` 但**不挂 preset**，跨 profile 共用 `~/.dsh/sessions` 时同一会话在那三条通道续跑会换一套工具面，这属于宿主行为，本插件不越权修；③ 活 agent 不会自愈：`agents.get()` 命中直接复用、不校验工具面，出问题的 agent 要被 dispose 之后下一次冷恢复才会重新组合。

## 0.12.2 — 把「碰巧对」加固成「结构上对」（0.12.1 的对抗性复核）

0.12.1 修好了事故，但复核发现它有三处「今天能跑、明天会翻车」的假设。这一版只加守卫、不改行为。

- **`sessionController.composeAgent` 在生产上不存在**：本机 0.2.2 的 `SessionController` 只暴露 `resolveAgent`，`composeAgent` 属于内部 `ApiSessionAgentController`（`packages/api/session-controller/src/index.ts:179,268` 与 `agent.ts:271`）。所以 0.12.1 写的「优先 composeAgent（与 Web 同一条路径）」分支**从来没执行过**，真正一直在跑的是 `agentPresets.resolve` + `mount`（正确的那条）。这一版改正了注释，并给那条兼容分支加了守卫：**返回的 composition 没带 `agentPreset` 就判失败**——否则宿主在无 preset 注册表的 profile 会返回「只装模型选择」的 setup 并静默忽略 presetId，正好复刻事故。
- **读会话 preset 改用受支持的投影**：`snapshotEvents()` 已被宿主标 `@deprecated`（`core/session/src/index.ts:718-723`）。改为首选 `agentPresets.presetForSession(session)`（语义 = header + 最后一条 `agent-preset/selected`，与 `docs/design` 的 fold 完全一致），日志扫描降级为兜底。已核该投影对「尚未 enter 的 setup 期会话」可用（`session-projection/src/index.ts:840-853` 懒折叠）。
- **并发冷恢复不再误记失败**：同进程另一条路径（用户消息 / 另一个闹钟）刚把同一会话 resume 起来时，本插件的 `agents.resume` 会因宿主写锁抛 `SessionAlreadyOwnedError`；现在改为复用已上线的 agent，而不是记一次 wake 失败（supervision 连续 3 次失败会降级停调度）。
- **降级留痕**：挂到宿主默认 preset 时，warn 里写明「本次挂的是宿主默认，不是 header 记录的 id；不写 `agent-preset/selected`，所以每次冷唤醒都会重付一次失败+降级」。
- **验证**：`npm test` EXIT 0（30 个套件），`test/resume-setup.test.mjs` 由 8 组 / 42 条断言扩到 **12 组 / 60 条**，新增：生产形状（只有 `resolveAgent`）走 `agentPresets` 分支、`composeAgent` 无 `agentPreset` 判失败并降级、投影可用时不碰 `snapshotEvents`（计数器证明）、`SessionAlreadyOwnedError` 复用活 agent。变异验证：改回 0.12.1 的实现后新用例立刻红。
- **已知边界**：① `src/engine.js` 的 `_composeWithHostPresetServices` 仍是「composeAgent 返回没有 agentPreset 时用 requested 兜底报成功」，这一版只改了注释没改行为（节点建会话路径今天不受影响，因为该分支不可达；要一并收需要单独拍板）；② 守卫只判「非空字符串」，不判返回的 id 是否与请求一致；③ 仍依赖 `SessionAlreadyOwnedError` 这个 error name 约定。

## 0.12.3 — 口径对齐：token 记账、节点终态与审计误报

这一版不改用户可见的功能面，修的是「文档 / 裁决已经写了 v1.3 口径，实现还停在旧门禁」的七处落差：token 记账会把缓存与重试用量算丢，节点终态会被迟到的自审回报改回 `working`，健康审计拿默认阈值误报、把 restart 跳过的阶段算成偏航。

> **历史 run 不回写（append-only）**：以下修复只影响此后写入的事件与 `run.json`。已有的 `.jsonl` 事件、`tokenTotal`、`run.json.tokenCoverage` 一个字节不动——事件永不改写，`run.json` 的 token 计数只随新写入的事件累加。所以历史 run 上仍然会看到旧口径（例如 `cacheRead=0`、少记的 token），这是证据保全的预期结果，不是没修。

### 1. 外部 executor 的 usage 四桶化

- **问题**：codex 的 `input_tokens` 是「命中缓存 + 未命中」的**总和**，`cached_input_tokens` / `cache_write_input_tokens` 是其中的子集。旧归一化把总和整段塞进 `input`、两个缓存桶恒 0，于是抽屉里的「未命中输入」被放大、四段构成条失真。`test/executor.test.mjs` 按其真实形状（`r-mw954abc-dcgj` / `n-exec` attempt 1）记录：`input_tokens` 里 96%~97% 是缓存命中。
- **修法**：`normalizeUsage()` 改为返回四桶 `{ input, cacheRead, cacheWrite, output, total }`：`cacheRead = cached_input_tokens`（也认 `cachedInputTokens` / `cache_read_input_tokens`）、`cacheWrite = cache_write_input_tokens`（也认 `cacheWriteInputTokens`），`input = max(0, input_tokens − cacheRead − cacheWrite)`；`total` 优先取显式 `total_tokens`，否则 `input_tokens + output`。矛盾数据（缓存比 input 还大）按 raw input 截断缓存桶，`input` 不会被减成负数。
- **口径不变**：引擎落盘的 `tokenTotal` 一直是「四桶相加」，所以总量口径不变——变的是同一笔钱记在哪个桶里。`reasoning` 仍只在 `0 ≤ reasoning ≤ output` 时保留。
- **证据**：`src/executor.js:327-345`（归一化）、`src/executor.js:390`（`parseCodexLine` 消费）；`test/executor.test.mjs` 的「A：codex 四桶拆分——缓存命中从 input 扣出，四桶之和恒等于旧 total」（含真实形状、无显式 total、cache write、camelCase / 下划线别名、cache > input 五类断言）。
- **引擎侧配套**：`accumulateExternalUsage()` 改为四桶累加（旧实现只加 `input` / `output`，只要出现过任意一条 usage 就整段丢掉 executor 拆出来的缓存桶）；`_runExternalNode` 的 `usage = usageSum || mapHostUsage(result.usage) || mapHostUsage(lastUsage)` 三条来源走同一张四桶表。见 `src/engine.js:268-285`、`src/engine.js:6843-6848`；回归是 `test/engine.test.mjs` 的「G① accumulateExternalUsage：四桶累加，总量与两桶口径一致，reasoning 语义不变」与「D/G② 外部 executor 重试两次：两条 model/call、callId 不同、四桶都在、总量不丢」。

### 2. 重试的 callId 唯一化（token 不再被去重账本吞掉）

- **问题**：去重账本是「同 `traceId + callId` 后到整条替换」。同一 attempt 内的节点级重试会再真实调用一次模型 / 外部进程，但旧实现两次都写 `callId = executor:<nodeId>:<attempt>`，后一次把前一次的用量**整条替换**掉。实测 `r-mw8090s2-0hi4`：三条 `model/call` 的事件级四桶合计 **1,938,649**，`run.json.tokenTotal` 只有 **1,246,593**，少记 **692,056**（35.7%）——丢掉的正好是 `n-review` attempt 1 第一次调用的整条用量。
- **修法**：无重试仍用 `executor:<nodeId>:<attempt>`（历史兼容）；有重试时带重试序号 `executor:<nodeId>:<attempt>:<retryIndex>`，两条是两次真实调用，聚合层不会再替换。
- **证据**：`src/engine.js:6858-6864`；`test/engine.test.mjs` 的「D/G② 外部 executor 重试两次：两条 model/call、callId 不同、四桶都在、总量不丢」；真实实例 `r-mw8090s2-0hi4`（该 run 是修复前的历史 run，按 append-only 不回写，少记的 692,056 不会补回）。

### 3. `run.json.tokenCoverage`（新字段：账记全了吗）

- **问题**：`tokenTotal` 只回答「一共多少」，不回答「该记的调用有没有漏记」。外部 executor 被 kill / 不支持上报时 `model/call` 会缺席，token 只会偏小且没有任何标记；`unkeyedCalls > 0`（没有 `callId` 的用量进不了去重账本）同样会让累计值失真。
- **修法**：run 收口时写 `run.json.tokenCoverage = { complete, missing, buckets }`：
  - `missing` 是「跑了外部 executor 却没留下 `model/call`」的 `{nodeId, attemptId}`（有界 50 条）；
  - `buckets = { seen, missing }`：四个桶里哪些从未报过数值，**纯信息**；
  - `complete = (missing.length === 0) && (unkeyedCalls === 0)`，**只反映结构完整性**。桶缺失不压 `complete`——否则不支持缓存的 provider 会永久黄灯。
- **写入顺序**：`tokenCoverage` 与 supervision 终态在同一次 `writeRunMeta` 里写，且都在 `run/end` 落盘**之前**；重写幂等（覆盖度只算一次并缓存）。见 `src/engine.js:346-373`（`tokenCoverageFromSeen`）与 `src/engine.js:3866-3893`（`_persistRunEndMeta`）。
- **读端**：`runstore.normalizeTokenCoverage()` 做有界收敛并进 `normalizeMeta` 白名单（`src/runstore.js:525`、`src/runstore.js:579-583`）；`src/index.js` 的 `tokenCoverageOf()` 对外投影——`GET /runs` 列表行只给 `{ complete }`，`GET /runs/<runId>` 详情给全量（`src/index.js:983-1005`、`src/index.js:1844`、`src/index.js:1942`）。老 run 没有这个字段时按 `{ complete: true }` 兼容，不把「没记录」误报成「有缺口」。
- **证据**：`test/engine.test.mjs` 的「B（token 覆盖度）：complete 只看结构缺口，桶覆盖单独放 buckets；run/end 收口显式写」、`test/metrics.test.mjs` 的「B：tokenCoverage 对外暴露——列表 / light 只给 { complete }，详情给全量」、`test/runstore.test.mjs` 的收敛用例。

### 4. quality 判定口径（实现与 05 §8.4 的 v1.3 对齐）

- **问题**：0.11 起 `computeQuality` 里叠了三道旧门——`claimedOnly`（三项都 `claimed>0` 且 `authoritativePassed===0` → `unknown`）、`unverifiedMix = claimedPassed > 0`（任何 claimed 通过 → `unknown`）、以及「权威覆盖 < 100% → `unknown`」。结果 `pass` / `warn` 在真实 run 上不可达：引擎对 `acceptance/verdict`、`test/report` 一律写 `provenance:'model-claim'`，只有宿主 `check/form` 是权威。这个缺口在 [0.11 功能缺口评估](../plan/0.11-功能缺口评估.md) 里记为 G-E，05 §8.4 的 v1.3 裁决已经改成「按产物归属判独立性」，实现没跟上。
- **修法**：删掉上述三道旧门（`claimedOnly`、`unverifiedMix`、`QUALITY_PASS_MIN_AUTHORITY_COVERAGE` 作为门禁）。现在的结论层口径以 `src/runlog.js:2663-2742` 为准：
  - 某指标通过条目**全部为自证**（`selfOnly`）→ `warn`（label「<指标名> 全部为自证证据（N 条），缺独立复核」）；
  - 有通过条目但**找不到产物归属**（ref 对不上 artifact / write）→ `warn`（label「<指标名> 共 N 条通过条目找不到产物归属，缺独立复核」）；
  - 五项证据任一项 `unknown` → `unknown`；任一项 `fail` → `fail`（fail 压过 unknown）；
  - 每个有通过条目的指标都至少有 1 条 peer / host 独立证据时仍可 `pass`，自证条目可以共存（总数在 `quality.selfCertified` 里展示）。
  - `authorityCoverage` 仍如实返回，但**只用于展示**，不再是 pass 门禁；客户端在有 `independentPassed` 时也不再拿 coverage 二次降级（`src/client/logdrawer.js:1607-1627`）。
- **证据**：`src/runlog.js:2520-2550`（旧常量注释改为「不再作为 pass 门禁」）；`test/metrics.test.mjs` 的「C v1.3 独立性判定表：全 self → warn；peer + self → pass；fail → fail；无证据 → unknown」。
- **影响面**：`acceptance` / `tests` / `checks` 三处指标新增 `independentPassed`（peer / host 独立通过的条数），产物归属能对上的「引擎自写报告」不再整条判 `unknown`，而是计入自证并在 quality 层按 `selfOnly` 兜底 `warn`。

### 5. `nodeStatus` 终态化（`state` 不扩枚举，结论放 `verdict`）

- **问题**：`node/end` 落盘后，节点在 `run.json.nodeStatus` 里仍可能停在 `working`——终态要等模型自审回报；而同一 attempt 迟到的自审回报又会把已经收口的节点改回 `working`。`runstore` 只认 `working / done / blocked / failed` 四值，写别的值会被静默回落成 `working`。
- **修法**：`state` 仍是四值，**不扩枚举**；通过 / 打回结论由 `verdict`（`pass` / `reject`）承载，客户端已单独渲染成徽标（`src/client/flowlist.js:246`、`src/client/flowlist.js:335-340`）。引擎在 `node/end` 收口时定终态：`passed → done + progress 100 + verdict pass`；`rejected → failed + progress 100 + verdict reject`；`failed / aborted → failed + 实际进度`（中止的真实原因仍看 `run/end.status` 与 `node/end.extra.aborted`）。
- **迟到回报不回写**：同一 attempt 一旦写入终态，晚到的自审状态块**只写 `node/status` 事件留痕**，不改内存快照、不改 `run.json`（`src/engine.js:2880-2927`）。合法重开只有两条判据：`attemptId` 变化，或 `node/start{data.retry}` 的重试序号递增（`src/engine.js:2723-2763`）。
- **只收口已存在的条目**：只有上报过自审状态的节点才有 `nodeStatus` 条目；`node/end` 不凭空创建条目（外部 executor 节点没有会话、不写 `nodeStatus`，这是既有契约）。
- **run 收口兜底**：run 进入终态时，仍停在非终态的 `nodeStatus`（含 `blocked`）一并落成终态，attempt 对齐引擎权威计数（`src/engine.js:2786-2808`、`terminalNodeStatusForRunEnd`）。
- **证据**：`src/engine.js:178-234`（映射与纯函数）、`src/runstore.js:666`（四值枚举）、`src/runstore.js:725-790`（白名单收敛，`verdict` 只接受 pass / reject）；`test/engine.test.mjs` 的「B① 终态映射：passed→done/100/pass，rejected→failed/100/reject，failed→failed/实际进度」「B② 终态后迟到的 self-check 不回退 run.json（事件照写）；重试 / 新 attempt 可重开」「B③ run 被中止：working 节点收成 failed + 实际进度，run.json.status 仍是 aborted」。

### 6. 收口顺序、停止归因与占位符产物

- **收口顺序**：`supervision = {enabled:false, reason:'terminal', nextDueAt:null}` 与 `tokenCoverage` 在 **`run/end` 落盘之前**、同一次 `writeRunMeta` 里写（`src/engine.js:3866-3893`，调用点在 `src/engine.js:5841`、`src/engine.js:6421`）。旧顺序是「先写 `run/end`、runtime 再落 supervision」，进程死在两步之间会留下 `enabled:true + nextDueAt` 的自相矛盾快照——实例 `r-mw900w7y-r4s3` 的 `nextDueAt` 比 `endedAt` 晚 10 秒、`r-mw77wlyt-1t2j` 晚 37 秒。
- **停止归因**：`engine.stop(runId, { source })`。`source='user'`（默认，保持历史行为）→ `run/end.reason='已停止'`；`source='engine'`（`runtime.js:1992` 在 dispose 时传）→ `run/end.reason='引擎中断（宿主卸载 / 服务重启）'`。节点 `node/end.extra.reason` 与 `run/end.reason` 共用同一份文案（abort 的 message 就是它），不再一律写「用户停止」。常量与收口函数见 `src/engine.js:157-163`、`src/engine.js:5132-5173`。
- **事件顺序**：`node/end` 必须先于同一节点 / attempt 的 `machine/transition`。两处倒置已修（成环与步数上限路径）：`_failNode` → `_sendMachineEvent`，见 `src/engine.js:5998-6007`、`src/engine.js:6015-6023`。
- **占位符产物**：新增 `artifact/write.data.placeholder=true`。判据刻意保守——整段正文 trim 后只剩「见文件 / 详见附件 / see file」这类一句话且总字节 < 32；二进制产物不判。**只加标记，不改写入行为**（不因为像占位符就拒绝落盘）。见 `src/engine.js:399-427`（`isPlaceholderArtifactContent`）、`src/engine.js:7676-7681`。
- **证据**：`test/engine.test.mjs` 的「A① stop 来源归因：user →「已停止」，engine →「引擎中断（宿主卸载 / 服务重启）」」「C：run/end 落盘时 supervision 已是 enabled:false/terminal，nextDueAt=null（幂等）」「E：同节点同 attempt 的 node/end 必须早于 machine/transition（步数上限路径）」「F：明显占位符产物带 placeholder=true，正常短产物不带；写入行为不变」。

### 7. `flow_watch` 误报修复（审计模块）

- **问题一（阈值）**：审计内部写死默认 20 分钟节点上限 / 2 小时 run 上限，不读 run 自己的 `run.json.limits`。本机 `r-mw8q41al-w5kk` 的 `run.json.limits` 是 `nodeTimeoutMs=1800000`（30 分钟），旧实现按 20 分钟默认值判「timeout-risk」；`src/tools.js` 的注释把这个实例记为本次误报的来由。
- **修法一**：阈值来源链改为「显式 `options` > `input.run.limits` > 默认」（`src/audit.js:353-438`），返回体新增 `thresholds = { stallMs, nodeTimeoutMs, runTimeoutMs, source }`（`source='run'` 表示节点 / 整轮上限取自 `run.json.limits`）；timeout-risk / stalled 的文案写实际阈值与来源，不再是默认值（`src/audit.js:769-800`）。`flow_watch` 在 `src/tools.js` 里先解析 `run.json.limits` 再显式传入，返回体也带 `thresholds`。
- **问题二（restart 误报）**：restart 续跑的 run 从中间阶段起跑，被跳过的阶段（`run.json.restart.skippedNodeIds`）在旧口径里既算「未执行」又算「偏航」，进度分母也不扣。
- **修法二**：审计尊重 `skippedNodeIds`：进度分母 = `nodeTotal − skipped`；被跳过的阶段标 `state='skipped'`、不进 `plan.expected`、不产 deviation；进度对象带 `skipped[]` / `skippedCount`（`src/audit.js:47-61`、`src/audit.js:490-527`、`src/audit.js:626`）。实例 `r-mw79hxdq-ujlb`（`skippedNodeIds=[n_frame,n_evidence,n_axes]`、`nodeDone=4`、`nodeTotal=7`）：旧 ratio `4/7 = 0.5714` → 新 `4/(7−3) = 1`。
- **证据**：`test/audit.test.mjs` 的「阈值：显式 nodeTimeoutMs=30 分钟 → 26 分钟的节点不报超时风险（默认 20 分钟会报）」「阈值：不传 options、只给 run.limits.nodeTimeoutMs → 也用 run 值（引擎 supervision 的调用形状）」「阈值：超时风险 detail / headline 写的是实际用的阈值，不是默认值」「restart 续跑：从第 3 阶段起跑不算偏航，跳过节点单列、分母扣减」「restart 续跑（全部跑完）：done + ratio=1，不再有偏航条目」「没有 restart 的 run：行为完全不变（skipped 为空、ratio 仍是 passed/total）」。

### 验证

- 全量回归：`npm test` **30 个测试文件 / 1076 组 / EXIT 0**（在版本号 bump 与 `npm run build` 之后、无并发写入的情况下重跑的一遍），其中 `test/engine.test.mjs`（140 组 / 1212 条）、`test/engine-restart.test.mjs`（10 组）、`test/tools.test.mjs`（73 组 / 1045 条）、`test/runlog.test.mjs`（101 组）、`test/runstore.test.mjs`（89 组）、`test/render.test.mjs`（103 组）、`test/executor.test.mjs`（33 组 / 230 条）、`test/audit.test.mjs`（23 组）、`test/metrics.test.mjs`（22 组）。
- 构建门禁：`node test/build.test.mjs` 8 组 / 66 条通过，`lib/client.js` 483,806 B（上限 524,288），src ↔ lib 22 个 Host 模块逐字节一致。
- 真实实例：`r-mw954abc-dcgj`（缓存占比）、`r-mw8090s2-0hi4`（callId 吞量）、`r-mw900w7y-r4s3` / `r-mw77wlyt-1t2j`（supervision 晚写）、`r-mw79hxdq-ujlb`（restart 跳过）、`r-mw8q41al-w5kk`（阈值误报）。它们都是修复前的 run，按 append-only 不会被回写。

### 已知边界

- `tokenCoverage.complete` 只回答「结构上有没有漏记」，不回答「数值对不对」；provider 少报一个桶但每条调用都有 `model/call` 时，它仍是 `complete:true`（桶覆盖只在 `buckets.missing` 里提示）。
- `normalizeUsage()` 的显式 `total_tokens` 优先；若上游给出的 `total_tokens` 与 `input_tokens + output` 不一致，落盘的 `usage.total` 与四桶之和会不相等（引擎落盘 `tokenTotal` 仍按四桶相加，不受影响）。
- 停机的节点 `node/end.extra.reason` 与 `run/end.reason` 是同一份文案，想区分「谁停的」要看 `run/end.status` 与文案本身，没有单独的 `source` 字段落进事件。
- `artifact/write.data.placeholder` 只标「像占位符」，不改变证据判定；质量层怎么用这个标记不在本版范围（`src/runlog.js` 的归属判定不读它）。
- `run.json.tokenCoverage` 在客户端指标区尚未渲染，目前只通过 `GET /runs` / `GET /runs/<id>` 暴露给集成方。

## 0.13.0 — BPMN 引擎与双域存储

这一版换的是**引擎内核与存储域**，不是画布：模板从一份可变的流程 JSON 变成不可变的 BPMN 定义，运行实例从 `runs/` 换成 `instances/`，路由语义从自研的 `next / reject` 换成 `bpmn-engine@26.0.6` 的 BPMN 2.0 子集。老的 `flows/`、`runs/` 与 `src/engine.js` 原样保留（画布 0.13.3 才替换），新路径另开目录，不做兼容双轨。

### 1. 模板域 / 实例域分离

- **布局**：`definitions/<id>/meta.json + <version>.bpmn` 与 `instances/<id>/instance.json + definition.bpmn + state.json + events/<activityId>/<attempt>.jsonl` 平级于老的 `flows/`、`runs/`；两个域不同目录、不同 id 空间、不同生命周期（`docs/design/10-bpmn-instance-api.md` §2）。
- **定义不可变、可版本化**：同一 `(id, version)` 一旦落盘只接受相同字节（hash 相同即幂等成功），显式版本换内容 → 409 `DEFINITION_VERSION_IMMUTABLE`；目录 0700、文件 0600，`definitions` 根上一把跨进程 `.lock`（`src/definition-store.js:632` 的 `saveDefinitionVersion`）。
- **实例钉住定义**：启动时冻结 `definitionId + version + hash`，并复制一份 `definition.bpmn` 进实例目录，之后只读自己的快照；定义被改版 / 被删都不影响已启动实例（`src/instance-store.js:584` 的 `createInstance`）。
- **沿用 0.12 的成熟部分**：append-only 事件分片、`revision` 乐观锁、原子写、终态写保护；`seq` 在实例锁内先分配再追加，跨分片全局单调（允许崩溃空洞，不重复）。

### 2. BPMN 2.0 XML 解析与 FEEL 条件

- **解析器**：`src/bpmn-parse.js` 用 vendored `bpmn-moddle@10.3.1` 加自定义 `fs:` 扩展命名空间，把节点类型、角色提示词、skills、`adapter` 等落成 `fs:node`；解析结果带 `definition.hash`（XML 的 sha256），与定义域入参对账。
- **只允许一个安全子集**：`src/bpmn-policy.js:22` 的 `ALLOWED_ACTIVITY_TYPES` 只放 `startEvent` / `endEvent` / `serviceTask` / `userTask` / `exclusiveGateway`；条件事件、标准 / 多实例循环、并行 / 包容 / 复杂 / 事件网关、`scriptTask`、子流程 / `callActivity` 在**解析期**就拒，专用错误码 `PARALLEL_GATEWAY_FORBIDDEN` / `INCLUSIVE_GATEWAY_FORBIDDEN` / `BPMN_CONDITIONAL_EVENT_FORBIDDEN` / `BPMN_STANDARD_LOOP_FORBIDDEN`，其余 `BPMN_EXECUTION_UNSUPPORTED`。
- **条件只走 FEEL**：`src/bpmn-expr.js` 用 vendored `feelin@8.2.0` 求值，自动剥 Camunda 风格的 `=` 前缀；`language="javascript"` 一律拒绝（`bpmn-engine` 内置实现走 `node:vm`，实测可逃逸到 `process`），`process` / `require(` / `constructor` / `this` 命中即拒（先剔除字符串字面量，避免误伤）。测试里有反例锁：`= false` 必须走默认流。
- **不让内置表达式引擎兜底**：runner 通过 `scripts.getScript` 接管每条带 `conditionExpression` 的连线；内置解析器会把 `= 1 > 2` 当成属性路径，条件静默恒真——这是研究阶段实测出来的红线，不是理论风险。

### 3. `bpmn-engine@26.0.6` 的最小执行面

- **三种元素**：agent 节点 = `bpmn:serviceTask`（handler 是 `executeAgent`）、人工节点 = `bpmn:userTask`、分支 = `bpmn:exclusiveGateway`。人工任务的「完成」= `execution.signal({ id, executionId, payload })`；`pendingTasks[]` 只回答「谁在等人」，没有 assignee / 认领 / 表单 / TTL。
- **`flow/taken` 取代 `reject/trigger`**：每条实际走过的连线落一条一等事件，带 `flowId / from / to / condition{expression,value}`；旧模板的「打回」迁移成普通反向条件连线，`fs:maxRounds` 只表示「这条连线最多被走 N 次」这个通用上限（`src/bpmn-runner.js:442`）。
- **活动事件只从 `execute({listener})` 出来**（`engine.on(...)` 收不到），由 runner 统一封装；快照只在 `activity/wait` 与 `activity/end` 之后取（`src/bpmn-runner.js:221`），不做逐事件 `getState()`。
- **护栏**：活跃实例 LRU（`FLOW_STUDIO_BPMN_MAX_ACTIVE`，默认 100）、单活动 / 整轮双超时、单连线次数上限加循环护栏；LRU 要淘汰一个「还没落过 state」的实例时明确拒绝（503 `BPMN_LRU_EVICT_UNSNAPSHOTTED`），不静默丢实例。
- **路由**：`/api/flow-studio` 下 10 条定义 / 实例 API（定义列表 / 保存 / 读取，实例创建 / 列表 / 详情 / 事件 / 待办 / 完成 / stop），沿用现有鉴权、只读令牌与同源校验；`/health` 的 `bpmn` 计数每次现算。中途去掉了 `FLOW_STUDIO_BPMN` 灰度开关：新路由常开，不做兼容双轨。
- **依赖**：`bpmn-engine@26.0.6` 的五个 peer 组件改成直接依赖——pnpm profile 不自动安装传递 peerDependencies，只声明 `bpmn-engine` 会让插件在真实 profile 里 import 失败（容器测试台实测）；`bpmn-moddle` / `feelin` / `zeebe-bpmn-moddle` vendor 进 `src/`。

### 4. 重启恢复：原生 `getState/recover` + 状态信封 v2

- **恢复路径固定**：新建 `Engine` → `recover(state)` → `resume({listener})`；`recover()` 不能喂给运行中的 engine。
- **信封 v2**（`src/bpmn-state.js:36`）：`kind / instanceId / definitionId / definitionHash / version / processId` 必填，并绑定执行 XML 的 `sourceHash`；裸 `bpmn-engine` 快照与 v1 信封直接拒绝，不迁移、不补 hash。
- **恢复前先比对执行结构**：从**可信 XML** 用与执行相同的 moddle / serializer 生成结构，与快照里的元素 id / 类型 / 配置、连线端点 / 条件 / 默认流 / 上限 / 出边顺序、start / end 逐项比较；`flowTakes` 必填且与引擎计数强一致，删掉或改坏计数不会让已耗尽的边复活。任一项不符 → `BPMN_STATE_DEFINITION_MISMATCH` / `BPMN_STATE_VERSION_UNSUPPORTED` / `BPMN_STATE_INVALID`，**handler 调用数 0**。
- **懒恢复**：请求碰到不在内存里的实例才恢复；`recovered:true` 只表示「本次请求重建了 runner」。终态不恢复；`state.json` 缺失时 GET 200 + 可读原因、写操作 409；快照损坏 → 500，不拿定义域的最新版冒充。
- **恢复点**：运行时在每次操作收口后（wait / end 之后）显式 `getState()` 一次写 `state.json`，runner 的自动快照关掉，避免同一点取两次 7–18 KB 快照。

### 5. 旧 JSON → BPMN 转换器与迁移脚本

- **转换口径**（`src/bpmn-convert.js:789` 的 `convertLegacyFlow`）：`start` / `end` → 对应事件；其余节点 → `serviceTask` + `fs:node nodeType="agent"`，节点全字段进 `fs:node`、无法映射的进 `fs:legacy`；`next` 边 → 普通 `sequenceFlow`，第一条 `next` 设 BPMN `default`，其余不自动编条件、只给 warning；旧 `reject` 边 → 反向条件连线，单条写 `= verdict = "reject"`，多条写成互斥条件并按老引擎 `leftmost` 选默认目标、其余靠 `rejectTarget` 选中，回退上限落 `fs:maxRounds`；同时生成 `bpmndi` 图与分层坐标，bpmn.io 打开就有布局、节点不重叠。
- **往返是硬门禁**：生成的 XML 必须能被 `parseBpmn()` 重新解析，节点 / 边数一致；测试覆盖 3 节点 + 1 条打回边的 round-trip。
- **迁移 CLI**（`scripts/migrate-flows-to-bpmn.mjs`）：默认 **dry-run**，只打印计划，`--apply` 才写；每个文件先 `convertLegacyFlow()` 再 `parseBpmn()` 复核，任一步失败 → `skipped`，原文件留在 `flows/` 不归档；保存后回读，要求「meta 记录 hash = parseBpmn 的 definition.hash = sha256(xml)」三者一致，否则 `failed`；同 hash 已是当前版本 → `unchanged`，不重复归档；归档只 rename 不删除，同名冲突退 `*.json.bak-<时间戳>`；写 `migration-report.json`，退出码 0 / 1 / 2 分别表示全部成功、有 skipped 或 failed、参数 / 路径错误。

### 6. 执行白名单、失败停机与实例状态口径（A1/A2 与复审收口）

- **A1 · 条件与恢复入口封闭**：解析期白名单加运行期拒绝型表达式解析器双保险；删除生产入口的 `evaluateCondition` 替换选项（传入即 `BPMN_OPTIONS_INVALID`）；恢复路径先校验身份与结构再 `recover()`。修前可复现：条件 startEvent `= 1 > 2` 照常执行、裸并行网关快照恢复成功并产出两个待办；修后分别得到 `BPMN_CONDITIONAL_EVENT_FORBIDDEN` 与 `BPMN_STATE_VERSION_UNSUPPORTED`，handler 调用 0。
- **A2 · 超限 / 失败 / 取消立即停机**：用 `elements.SequenceFlow` 注入点包住原 `take`，在发布、计数、推动目标之前统一检查并预占 `flowTakes`（条件边、默认边、无条件边都覆盖）；`_fail` 同步锁定首个终态并 abort 在飞活动，`error` 之后不再出现 `activity/start`；stop 在实例串行队列外置停止闩并发取消信号，慢 complete 挡不住 stop。
- **复审的 3 BLOCKER + 7 MAJOR**：快照布尔字段只接受真布尔、出边顺序与节点路由标记纳入比较、补偿属性进执行白名单；`start()/recover()` 在异步校验后复核取消代次；恢复绑定 `instanceId` / `sourceHash`；失败停机写「不可恢复」墓碑（实例仍 `ACTIVE + lastError`，但重启 / 淘汰后不再自动恢复旧执行位置，`complete` 明确 409）；交给 handler 的变量改深拷贝；终态写保护覆盖事件追加 / 快照 / 进入终态时的 `pendingTasks` / `artifacts`；stop 与慢 complete 并发时以 409 `INSTANCE_TERMINAL_IMMUTABLE` 收口，不再返回 200 + `ACTIVE` 的假成功；`recover` 的 settle 加有界超时且只认可信 id；`definition-only` 顶层 `maxTakes` 生效（与 `fs:maxRounds` 冲突显式报错）；`instance.json.artifacts` 落库并受终态保护。
- **状态口径（Camunda 8）**：实例只有 `ACTIVE / COMPLETED / SUSPENDED / CANCELED`（`src/instance-store.js:66`），终态只有 `COMPLETED` 与 `CANCELED`；**没有 `failed`、没有 `blocked`、也没有状态机**——`status` 是普通持久字段，由 runtime 按事件写。中途一度加过 `blocked`，随后整段撤掉：引擎出错（条件错、超时、handler 失败、adapter 不可用、连线超限、循环护栏）时实例**保持 `ACTIVE`**，写 `lastError{code,message,nodeId?,activityId?}` 并发 `error` 事件，是否重试 / 终止由业务或人决定。三个新域文件里 `'failed'` 零命中，runtime / store 无 `'blocked'` 字面量，测试里有防回潮断言。

### 验证

- `npm test` **43 个测试文件 / 1287 组 / 0 失败**（0.13.1 收口后的全量回归，27 个套件显式计数合计 **7467 条断言**；`&&` 链走到第 43 个套件并打印汇总，日志里无失败标记）；0.13.0 新增的 8 个套件是 `definition-store`（9 组 / 74 条）、`instance-store`（14 组 / 154 条）、`bpmn-expr`（11 组 / 54 条）、`bpmn-parse`（23 组 / 129 条）、`bpmn-convert`（11 组 / 200 条）、`bpmn-runner`（43 组 / 451 条）、`bpmn-runtime`（17 组 / 254 条）、`migrate-flows`（11 组 / 154 条）；0.13.0 合入时是 38 个文件；A1/A2 复审期间加入 `node-finish` 后 39 个；0.13.1 再补 4 个，全量 43 个。`npm run build` EXIT 0（`src ↔ lib` 40 个 Host 模块逐字节一致、37 个打包输入、`lib/client.js` 483,806 B）。

### 已知边界

- 未做画布：0.13.3 之前仍是旧的 React Flow 画布，BPMN 定义目前只能由 API 或迁移脚本产生，没有可视化编辑 / 属性面板 / GUI 待办面板。
- 0.13.0 的 `adapter="dsh"` **明确失败**（`BPMN_AGENT_ADAPTER_UNAVAILABLE`，文案指向 0.13.1），`codex` / `custom` 仍走 `src/executor.js`；HTTP connector 未实现（`BPMN_HTTP_NOT_IMPLEMENTED`，0.13.4）；人工任务只开 HTTP 完成入口。
- 新实例的事件流**不接老 `audit.js`**：新事件还没有对应的审计判据，0.13.0 不把新事件塞进老审计（口径迁移尚未做，0.13.1 也没做）。
- 并行 / 包容网关在解析期直接拒绝（上游 #204：并行汇聚 + 成环会提前通过），团队节点只能走节点内 fan-out，不用 BPMN 并行网关。
- codex 用户全局 `~/.codex/config.toml` 的 hooks / mcp_servers 未隔离（0.13.1 也未做）；真实模型 turn 不在自动化测试里；Windows 清理未实机验证：进程 / 文件清理的 Windows 分支没有实机回归，自动化都在 Linux 上跑。

## 0.13.1 — AgentAdapter 与 flow_finish_node

这一版把 0.13.0 里「明确失败」的 dsh agent 节点接成可用，并把「节点算不算完结」从看输出文本改成**必须调用工具**：agent 节点要完结自己、让流程往后流转，只能通过 `flow_finish_node`。引擎语义不变，交付 5 个测试套件。

### 1. 适配器冻结接口

- **形状**（`src/agent-adapter.js`）：`probe() / capabilities() / start() / cancel() / dispose()` 五个方法，`start()` 返回 `{ exited, sessionId?, agentId?, pid? }`；注册表提供 `register / get / list / probeAll`，`probeAll()` 对单个适配器的探测上限 15s，超时按 `ok:false` 记录，不拖住其它适配器。
- **能力表**：`capabilities().finishTool` 只有 `native | unsupported` 两档——**不允许 `emulated` 文本解析这种中间态**；`hooks['turn.stop']` 允许 `native | emulated | unsupported`。**未成功 `probe()` 之前只能声明 `unsupported`**：`native` 是实测结论，不是静态声明。
- **结构化错误**：`ADAPTER_INVALID` / `ADAPTER_DUPLICATE_ID` / `ADAPTER_CAPABILITY_INVALID` / `ADAPTER_PROBE_INVALID` / `NODE_FINISH_TOOL_UNAVAILABLE`，上层按字符串分流，不靠错误类。
- **比 design/09 B-1 的拟议形状小**：`plan / resume / materialize / events` 不在冻结接口里；`resume` 目前只作为 codex 的提醒兜底，不是接口方法（`docs/design/09-agent-adapter-hooks.md` B-1 已注明以冻结子集为准）。

### 2. DSH 适配器

- **会话级工具**：在 `agents.create()` 的 `setup(agentCtx, agent)` 里 `agentCtx.tools.register(flow_finish_node)`，工具只在**该节点的会话**可见，节点结束随 disposer 回收。
- **提醒**：`agent/turn-stopping` 时没完结就 `agent.steer(提醒文本)`，默认最多 3 次；每次提醒经 `reminder.onFire` 翻成 handler 事件 `agent/reminder{count,maxFires}`，由 runner 透传，不新增一等事件 kind。
- **结局**：提醒用尽 → `finishGate.abort` + `exited={ok:false, code:'NODE_FINISH_MISSING', reminders}`，迟到 submit 一律 `NODE_ALREADY_SETTLED`；cancel / abort / dispose 都会 abort 闸门并 `agent.cancel({kind:'parent'})`。
- **提示词与来源**：节点提示词带 `node.prompt` / `roleCard` / `attempt` / 当前变量；注入消息在宿主里仍是合法 user message，同时带 `source.flowStudio` 供审计识别（`src/agent-adapter-dsh.js:840` 附近）。
- **宿主 API 全走发行版类型**：`agents.create` / `tools.register` / `agent/turn-stopping` / `agent.steer` 都以发行版 `.d.ts` 行号为证，不 import 未随宿主发布的 `experimental/hook-protocol`。

### 3. Codex 适配器

- **工具通道**：插件自带 MCP stdio server（`src/node-finish-mcp.js`）暴露同名 `flow_finish_node`；`codex exec` 通过**本次进程的** `-c mcp_servers.*` argv 加载它，不拼 shell、不改用户全局 `~/.codex/config.toml`、也不改工作区 `.codex/`。一个 MCP server 只拿一个随机凭据与私有 Unix socket，凭据只映射到内存里那一个 gate，不进 argv / 日志 / 提示词 / 磁盘。
- **完结只认通道信号**：只以 gate 收到 submit 为准，不解析 stdout 里的工具名，不写完成标记文件，不判「模型说完成了」。
- **提醒**：默认 `emulated`，用 `codex exec resume <session-id>` 进程级续跑；只有显式 `settings.stopHook === 'native'` 才注入原生 `Stop` hook（`decision:"block" + reason`）并标 `native`。该 native 结论来自手工隔离探测（第二把 Stop 的 stdin 带 `stop_hook_active:true`），**不是 probe 实测**，能力 evidence 里如实写。
- **模型 / 沙箱 / 审批显式 pin**：`-m <model>`；`exec` 用 `-s <sandbox>` 加 `-c approval_policy="<policy>"`（`codex exec` 没有 `-a` flag），`exec resume` 没有 `-s`，改用 `-c sandbox_mode="<sandbox>"`；默认 `workspace-write` / `never`，可被 `settings.sandbox` / `settings.approvalPolicy` 覆盖。
- **进程与凭据卫生**：子进程 env 走白名单（不继承宿主整个 `process.env`）；`handle.events / lastMessage / stdoutTail / stderrTail` 导出前把本 execution 的 token、socket 路径、runDir 路径替换成 `[redacted]`；cancel 杀**整个进程组**（含它拉起的 MCP 子进程），Windows 走 `taskkill /T /F /PID`；`dispose()` 用有界 grace 等退出，不 await pending 的 `exited`。
- **probe**：用 `codex mcp list --json -c mcp_servers.<name>.command=...` 验证 CLI 接受同一份配置形状，顺带验证 `sandbox_mode` / `approval_policy` 被解析；ENOENT 快速失败，总超时生效。

### 4. 完结门（`flow_finish_node`）

`src/node-finish.js` 是**被动**校验层：只做形状 / 上限 / 宿主侧文档校验，不提醒、不计数、不判 `NODE_FINISH_MISSING`（那是适配器 `turn.stop` 的职责）。

- **变量**：键 ≤32；值只允许 `boolean | number | string(≤512 码点) | null`；UTF-8 JSON ≤8192 字节；拒绝 `__proto__` / `constructor` / `prototype` 和任何嵌套对象 / 数组。超限 → `NODE_VARIABLES_INVALID`，整次调用失败，节点不结束。
- **文档**：≤32 份；`path` 必须是工作区内的相对路径（≤1024 字符，禁绝对路径 / `..` 段 / 反斜杠 / 空段）；`realpath` 必须落在工作区内（防符号链接逃逸）；必须是普通文件且 `nlink === 1`——**硬链接一律拒绝**；≤5 MiB；同一文件句柄分块读 + 前后 `fstat` 一致，sha256 与字节数对得上；`summary` ≤200 码点，超限整次拒绝不静默截断。
- **一次性**：一次活动只接受一次成功 submit；重复 → `NODE_ALREADY_FINISHED`（同参数重放也不重复写产物）；闸门 abort 后 → `NODE_ALREADY_SETTLED`；校验失败不锁死，修正后可重试。
- **产物只登记引用**：record 带 `output` / `artifacts[]` / `summary`，文档正文不进 record、不进事件、不进错误信息；错误里只出现工作区相对路径。

### 5. admission：先 probe，再断言 native

- `admit()`（`src/agent-execute.js:164`）先 `probeAdapter(adapter)`，成功后才 `assertFinishToolNative()`；probe 失败（codex 不在 / 未登录 / MCP 握手失败）与 `finishTool !== 'native'` 都收敛成**零派发** + `NODE_FINISH_TOOL_UNAVAILABLE`，不退回「看输出文本猜结论」。
- **每个 runtime 一份 probe 缓存**：同一 adapter id 只 probe 一次，同一节点的多个活动不重复起子进程；注册表空 / 未知 adapter → `BPMN_AGENT_ADAPTER_UNSUPPORTED`，连 probe 都不跑。
- 未 probe 的适配器只能声明 `unsupported`——这就是「未 probe 不宣称 native」的实现口径，也是 DSH 适配器在 `start()` 里会自动 probe 一次的原因。

### 6. 运行时接线（A3）

- **生命周期**：runner 的 agent 节点 → adapter → `finishGate` → `handle.exited`；成功只认闸门受理的 record，`activity/end` 带 `output` / `artifacts` / `summary`。
- **产物合并**：`instance.json.artifacts[]` 由 runtime 合并，去重键固定 `path + sha256`——同一活动重试、多个节点引用同一文件都不重复追加；内容变了（hash 不同）则是新产物；终态实例不再写（`src/bpmn-runtime.js:1606`）。
- **result 取最后一份 output**：`process/end` 时 `instance.result` 取**最后一个成功 agent 节点的 output**（`endEvent` 不产生输出）；变量只合并短标量，文档正文永远进不了网关条件（`src/bpmn-runtime.js:1472`）。
- **提醒用尽**：实例 `status` 保持 `ACTIVE`、`lastError.code = 'NODE_FINISH_MISSING'`（带 `reminders`）、发 `error` 事件，**不发 `process/end`**；是否重试 / 终止由业务或人决定。
- **超时与取消**：活动超时 → 适配器 cancel + dispose，收口为 `BPMN_ACTIVITY_TIMEOUT`；`ctx.signal` abort → `BPMN_ABORTED`；两者都不留 pending 会话，也不把失败写成实例终态。

### 验证

- `npm test` **43 个测试文件 / 1287 组 / 0 失败**（27 个套件显式计数合计 **7467 条断言**；`&&` 链走到第 43 个套件并打印汇总，日志里无失败标记）；本版交付的 5 个套件（`node-finish` 在 A1/A2 复审期间先落地）：`node-finish`（9 组 / 348 条）、`node-finish-mcp`（10 组 / 104 条）、`agent-adapter-dsh`（19 组 / 182 条）、`agent-adapter-codex`（15 组 / 201 条）、`agent-execute`（19 组 / 143 条）；`agent-adapter-codex` 里「真实 codex 0.167 probe」在找不到 CLI 时明确 SKIP 且不计入通过数。`npm run build` EXIT 0（`src ↔ lib` 40 个 Host 模块逐字节一致、37 个打包输入、`lib/client.js` 483,806 B）。

### 已知边界

- 未做画布：0.13.3 之前仍在旧的 React Flow 画布上，BPMN 定义没有可视化编辑 / 属性面板，人工任务只有 HTTP 完成入口、没有 GUI 待办面板。
- codex 用户全局 `~/.codex/config.toml` 的 hooks / mcp_servers **未隔离**：适配器只用 `-c` 传本次的 MCP 配置，没有独立 `CODEX_HOME`，也没加 `--ignore-user-config`；用户配置里的 hooks / mcp_servers 仍会作用到每个 codex 节点（能力 evidence 里同样如实写）。
- 真实模型 turn 不在自动化测试里：DSH 适配器用桩会话、codex 适配器用假 CLI 加真 MCP 通道；原生 Stop hook 只有手工隔离探测证据，`settings.stopHook:'native'` 时才启用，probe 不复测。
- Windows 清理未实机验证：`taskkill /T /F /PID` 与 socket / runDir 清理只在 Linux 自动化里跑过。
- `claude` 适配器与原生 hook 桥（`tool.pre` 可阻断）在 0.13.2；HTTP connector 在 0.13.4；画布在 0.13.3。

## 0.13.3 — bpmn.io 画布与主界面切换

**画布换成 bpmn.io**：`bpmn-js@18.31.1` + 官方 `bpmn-js-properties-panel@5.65.3`（`@bpmn-io/properties-panel@3.59.0`）只进懒加载 chunk `client.bpmn.js`，主包不含它们；宿主 `require.async('./client.bpmn.js')` 首次打开画布才加载。

- **体积**：`client.js` 161,160 B / gzip 37,998（旧 React Flow 画布移出主包）；`client.bpmn.js` 1,986,232 / gzip 539,385；官方 CSS 与 bpmn-font woff2 全部 base64 内联，零额外请求；`CLIENT_LIMIT` 硬失败改为只报数。
- **属性面板**：官方组件 + 自定义 `FsPropertiesProvider` 业务组（节点类型/provider/adapter/model/agentPreset、prompt/roleCard、skills/hooks、team、check、output、http、连线 maxRounds 与 FEEL 条件）；`moddle.create` + commandStack 合成一次撤销；check JSON 非法保留原文并报错；palette/替换菜单对齐执行白名单。
- **主题与许可**：`--bio-*` → `--dsw-*` 桥接（含暗色），主题切换不写 DI、不脏撤销栈；bpmn.io 水印保持官方显示（bpmn.io License 义务，见 THIRD-PARTY §四）。
- **主界面切到定义/实例**：左侧定义列表、中间画布、右侧实例与人工待办、底部实例事件抽屉；保存 = 提交属性输入 → 序列化 XML → `POST /definitions` → 钉 version/hash；运行强制 `definitionVersion`；实例用冻结快照 + NavigatedViewer 只读；事件 `?since=` 增量去重、按 `elementId` 定位；201 带执行错误时保留实例并展示 `lastError`。
- **新增接口**：`GET /instances/<id>/definition`（只读实例冻结 XML，不触发懒恢复）。
- **验证**：`npm test` 47 个套件 / 1235 组 / 8090 条断言 / 0 失败；真实浏览器（Chrome 149 + playwright-core）跑通新建/编辑/保存/运行/完成待办/事件定位/导入/201 错误保留；容器测试台（`dsh-testbed-bpmn`，0.13.3 tgz）实测 chunk 返回 200、定义/实例列表与画布渲染正常。

**已知边界**
- 旧 `flows/`、`runs/` 运行域与旧组件（React Flow 画布、inspector 等）仍在仓库，`api.js` 里以 `legacyApi` 临时保留；退役是下一步（0.13.3 收尾 / 0.14），当前页面已不调用它们。
- HTTP connector 尚未实现（`0.13.4`）；面板对 http 节点如实标注。
- bpmn-js 键盘绑定画布 SVG；输入框/面板内不触发图操作。

## 0.13.4 — 0.13.3 审查修复

这一版只修审查发现，不加功能。codex 对 0.13.3 的独立复审给出 1 BLOCKER + 9 MAJOR + 2 MINOR；本版关闭 BLOCKER 与其中 7 条，剩余 #9 / #10 / #12 的残留问题在 [0.13.5](#0135--0134-复审修复) 修完。

- **BLOCKER：画布变更没接到页面。** `BpmnCanvas` 从未收到 `mountOptions.onChange`，编辑器创建时捕获到的回调为空——打开已保存定义后改节点 / 属性 / 布局，页面仍认为已保存、不调草稿、运行也不被拦。现在按编辑器真实协议透传；编辑后出现「有未保存修改」、运行按钮禁用、600ms 去抖草稿落盘，保存期间继续编辑不会被保存响应误清 dirty。
- **导入失败整模型回滚。** 无 BPMN DI 的合法 XML 会先在 `importXML` 内部替换 `_definitions`、再在绘制阶段报 `no diagram to display`；旧实现只恢复 XML 字符串，接着保存就把新流程写进旧定义。现在先用 moddle 预检 DI，失败则重建 Modeler 并从旧 XML 恢复模型、dirty 与运行态 marker（撤销栈会清空，这是有意的安全取舍；导入期间的销毁 / 重建失败边界由 0.13.5 补齐）。
- **属性弹窗先 flush 再保存。** 官方弹出编辑器挂在 `document.body`，不在画布容器内，保存前只找容器内焦点会漏掉未提交输入；保存链先调 `editor.flushProperties()`（触发官方 `propertiesPanel.closePopup`，关闭时同步 flush 去抖输入），再序列化。
- **类型切换一次撤销。** 属性面板改用单条 `shape.replace` 并把目标类型放进 `hints.fsNodeType`，扩展修正由 behavior 在同一条命令的 `postExecuted` 内完成；撤销一次同时回滚类型与扩展，不再留下中间态。
- **替换菜单校验 nodeType。** 官方替换会复制扩展；现在校验 `fs:node` 的 `nodeType` 合法性，缺省 / 非法回落 `agent`，切成人工节点时清掉 serviceTask 专属字段。
- **HTTP 方法修改不再抛错。** `HttpMethodField.setValue` 引用了未定义的 `field`，已有 HTTP 配置后再改方法直接 `ReferenceError`；改用 `live.method`。
- **实例视图三处竞态。** 定义与实例共用选择世代，迟到的实例响应不再覆盖后选的定义；事件缓存与游标按 `instanceId` 隔离，请求失败不回退上一个实例的事件；进入终态停轮询前先追平 `detail.lastSeq`（成功路径不再漏掉最后的 `activity/end`、`process/end`；补拉失败与预留游标的边界由 0.13.5 修掉）。
- **待办 409/404 原因保留。** 完成人工任务失败时先刷新待办、后写原因，刷新不再把服务端原因清掉。
- **构建校验可信。** 新增 `lib/build-meta.json`：551 个输入文件 sha256 + 输入哈希 + 每个产物的 bytes/sha256；`verify-build` 对缺元数据、产物被替换、输入已变化一律失败。依赖泄漏检查改成内容特征 + VM 里真执行 factory，常见的删改元数据已拦不住；另补 6 条反例（factory 返回 null、主包混入真实 chunk、单字节替换等）。这一版仍靠自报哈希，改输入 + 重算元数据、无特征依赖夹带、factory 提前 `process.exit(0)` 还能绕过——0.13.5 改成独立重建比对与受限沙箱后才封住。
- **测试盲区。** 新增 `test/client-page-wiring.test.mjs`（8 组 / 66 条断言，修复前 8 组全红）与 5 组真浏览器回归；`npm test` 48 个套件、1221 组全过，浏览器 29 组 / 206 条断言全过。该测试当时自建画布桩、没有渲染真实 `BpmnCanvas` 壳，真实接线覆盖在 0.13.5 补上。

**已知边界**
- 新 BPMN 域目前只有 GUI 与 HTTP 入口，没有模型工具面（`flow_run_instance` 等）；对话里仍是旧 `flow_*` 工具，退役旧域前必须补（见 [0.14 计划](../plan/0.14-能力补齐与旧域退役.md) E3）。
- 旧 `flows/`、`runs/` 运行域、旧客户端组件与 `legacyApi` 仍在仓库，页面已不调用；一次性退役排在 0.14.0。
- HTTP connector 按新排期移到 0.13.5。

## 0.13.5 — 0.13.4 复审修复

codex 对 0.13.4 的复审结论是「原 BLOCKER 已关闭，但仍有 8 MAJOR + 2 MINOR」。这一版关闭了其中可复现的部分，并把构建校验从「信任产物里的自报哈希」改成「按源码独立重建后逐字节比对」；随后的复审又指出 6 MAJOR 残留/新增（F1–F6）与 3 MINOR，由 [0.13.6](#0136--http-connector-与-0135-复审修复) 修完。

**客户端（M1–M6、m1）**
- **实例切换失败要回滚（M1）**：选择 B 但 `readInstance(B)` 失败时，事件归属 / 缓存 / 游标 / marker 整体回滚到 A，不再留下 `activeInstance=A / eventsOwner=B` 的错位；后续对 A 的轮询正常继续。
- **终态补拉失败不停轮询（M2）**：「实例已终态」与「事件已追平」分开记录，补拉失败或游标不推进时按退避继续重试，只有真正追平才停；同时修掉「打开非终态实例就把 caughtUp 置真、转终态后停轮询」的竞态（M2b 回归）。
- **预留游标不再当已读游标（M3）**：Host 会先写 `instance.lastSeq` 再追加事件，详情里的 lastSeq 可能超前；现在 `since` 与显示游标只取**实际返回事件**的最大 seq，预留值只作为追平目标，不再永久跳过事件。
- **异步导入完成后按最新事件重算 marker（M4）**：导入返回时用当前实例归属的最新事件缓存重算，并在视图世代变化时丢弃，不再用调用时捕获的旧 marker 覆盖终态。
- **导入期间销毁不再复活 Modeler（M5）**：生命周期世代 + `assertAlive` 覆盖主要 await 边界（`saveXML` / `flushProperties` 的 await 后检查在 0.13.6 补齐）；销毁后禁止回滚重建，`onChange` 也检查 disposed。
- **回滚重建失败进入显式不可用态（M6）**：页面显示恢复失败原因、保存明确报「画布不可用（恢复失败）」，再次导入必须真正重建实例，不再假成功。
- **m1 测试盲区**：页面测试改为真实递归渲染组件树（`BpmnCanvas` 的 effect 真跑、`chunk.mountEditor/onReady` 真接线、卸载真调 `destroy`），删掉 `canvas.js` 的 `mountOptions` 透传会让 4 组变红。

**构建校验（M7、M8）**
- `verify-build` 主判据换成**独立重建 + 逐字节比较**：按当前源码在内存里用 esbuild 重建两个客户端包（官方 CSS/字体现场渲染注入，不读工作树里可能陈旧的生成物），与 `lib/` 逐字节比对；不一致直接失败并指出首个不同字节。
- 输入清单补进 4 份官方 CSS 与 1 个 woff2 字体（共 556 项）；每个产物写入模块清单（`client.js` 17 个模块、`client.bpmn.js` 461 个），verify 用**重建的 metafile** 交叉核对并做模块级泄漏断言。
- factory 执行移进受限 VM：白名单 `require` 拒绝 `process`，并带 3s 超时；只有字节 / 元数据 / 模块检查全部通过才执行（context 原型上的逃逸面在 0.13.6 用独立子进程 + null 原型 realm 封死）。
- 新增 8 条反例：改官方 CSS、只重算 `inputsHash`、主包夹带真实 `bpmn-js` Modeling bundle、factory `require('process').exit(0)`、直接 `process.exit(0)`、死循环、`constructor('return process')` 逃逸、无 prepack。

**agent 完结门（发布门槛缺口）**
- 删除 `executeAgent()` 里 `adapter=custom` 与「无注册表 codex」的旧 `runExternalExecutor` 逃生门：agent 节点只能经注册 adapter + `flow_finish_node` 完结；custom / 缺注册表一律零派发 + 明确错误码（`BPMN_AGENT_ADAPTER_UNSUPPORTED` / `BPMN_AGENT_ADAPTER_UNAVAILABLE`）。「成功结果只认完结门受理记录」的边界在 0.13.6 收紧（F5）。

**容器验收**
- 新增 `scripts/e2e-bpmn.sh`：打包 → 装进 `dsh-testbed-bpmn` → 重启容器内 dsh（带一次性插件令牌）→ health / 画布 chunk 字节一致 / 定义 / 实例 / 人工任务 / 事件 / 鉴权 / 宿主隔离全链路断言，实测连续 3 次通过（详见 [测试台 cookbook](../cookbook/run-container-testbed.md)）。

**测试**：`npm test` 48 个套件、1236 组全过；真浏览器 31 组 / 218 条断言全过（新增真实画布壳渲染与「导入期间销毁」用例）。

**已知边界**
- 终态补拉是「有界循环 + 退避的长期重试」：若 Host 预留 seq 永远不落盘，页面会持续显示明确错误并按退避重试，不会静默停住。
- 主包仍含旧 React Flow（退役在 0.14.0），所以构建校验对主包只硬禁 BPMN 栈、对 chunk 硬禁 `@xyflow`。
- m1 的页面测试用自建渲染器（真实组件函数 + effect 调度），不是 react-dom 的真实 reconciliation；真实浏览器覆盖在 `client-bpmn.browser.test.mjs`。

## 0.13.6 — HTTP connector 与 0.13.5 复审修复

这一版加 **HTTP connector**（BPMN serviceTask 真的能调外部 HTTP），并修 0.13.5 复审里 6 MAJOR + 3 MINOR 中可复现的部分；随后的复审又指出 8 MAJOR（H1–H5、N1–N3）+ 4 MINOR，由 0.13.7 继续收紧。

### HTTP connector（新能力）

- **配置**：仍是 `bpmn:ServiceTask` + `fs:node nodeType="http"`；`fs:http` 支持 `method / url / headers / body / timeoutMs / retries / authRef / networkPolicyId / maxResponseBytes / acceptStatuses / idempotency{Mode,Header}`。数据映射只认 `zeebe:ioMapping`（`inputParameters` / `outputParameters`），旧的 `fs:http.inputMapping/outputMapping` 不再支持、混用时明确报错。
- **目标策略**：「校验即连接」——URL 先拒绝 userinfo / 非 http(s)，DNS 的所有解析结果都分类（loopback / 私网 / link-local / metadata / ULA / CGNAT / IPv4-mapped 等），任一被禁就整次拒绝；返回的 `lookup` 只吐已验证地址并直接交给 `node:http(s).request`，连接时不会二次解析。默认只允许 HTTPS 公网；内网 / 明文测试台要显式配置 `allowedHosts` / `allowedCidrs` / `allowInsecureOrigins`。默认拒绝 3xx（不做重定向；某个状态码可用 `acceptStatuses` 显式接受，例如 304）。
- **限额与重试**：请求体 256 KiB；响应默认 1 MiB、硬上限 5 MiB（原始字节与解压后字节都计数，超限立即中断）；默认不重试，显式最多 3 次，只覆盖瞬时网络错误与 429/502/503/504，退避与 `Retry-After` 受整体 deadline 约束；有副作用的方法只有在配置幂等键（remote-key）时才允许重试。
- **幂等与恢复**：幂等键由 `instanceId + elementId + executionId + method + url` 生成，同一次执行的所有重试共享，循环重新激活换 execution 就换键。发送前先落盘调用记录（`<instanceId>/connector/`，原子写），成功结果在返回引擎前落盘；同一引擎快照恢复时已成功结果直接复用、不再请求远端，「已发送但结果不明」记 `HTTP_OUTCOME_UNKNOWN` 且不自动重发；跨快照崩溃恢复的幂等边界由 0.13.7（H5）收紧。
- **失败语义**：connector 错误写 `ACTIVE + lastError + error 事件`，不产生 `activity/end`、不走出向连线；不会把实例判成失败。
- **密钥**：`authRef` 只从宿主解析（环境变量 `FLOW_STUDIO_HTTP_AUTH_<REF>` 或注入的 resolver），请求侧不会把密钥写进 XML / 变量 / 事件 / 错误文本 / 日志；在 `fs:http.headers` 里手写 authorization / cookie / token 之类会被拒绝。远端把凭据回显到响应体 / 响应头的边界由 0.13.7（H3）收紧。
- **面板**：http 节点新增 `authRef / networkPolicyId / maxResponseBytes / acceptStatuses / 幂等模式与头`，输入 / 输出映射改成一行一个 `source → target`，写进 `zeebe:ioMapping`。

### 0.13.5 复审修复（F1–F6、f1–f3）

- **F1 实例回滚基线**：回滚改用「最后一次完整提交的实例状态」，连续选 B / C 失败也不会再让事件归属停在未提交的实例上；A 的轮询与游标恢复正常。
- **F2 导入串行化**：编辑器的「模式切换 + 导入」串行进同一个队列并带单调 token；过期请求在触碰真实模型前就放弃，已开始的导入之后由最新请求覆盖，迟到导入不再改写当前实例的模型。
- **F3 不可用态**：`setViewerMode()` 失败会销毁半成品并记下不可用原因；页面在任意成功恢复入口（打开定义 / 导入 / 草稿恢复 / applyView）统一把画布恢复 ready，不再出现「已恢复但保存仍禁用」。
- **F4 factory 隔离**：注册与 factory 检查移到**独立子进程**，realm 用 null 原型 + 禁 codegen + 不传入任何宿主对象；属性读取、序列化和错误格式化都在受限范围内执行，父进程只认带完成标记的结构化结果（不认退出码）。`globalThis.constructor.constructor('return process')` 等 11 条逃逸路径全部不可达，无限 getter 被超时中止。
- **F5 完结门只认受理记录**：agent 成功结果只来自 `await gate.result`；适配器先 abort 再自报 `ok/record` 一律判 `BPMN_ABORTED`，自报内容不进入返回值。
- **F6 容器脚本前置校验**：`scripts/e2e-bpmn.sh` 在安装 / 杀进程之前先核对容器身份、端口映射、PID/NET namespace 隔离、挂载不越界、监听进程身份、日志 token 登录 303；任一不符直接失败且不动任何东西。容器内没有在跑实例时走 **bootstrap**（由脚本启动 dsh 并证明端口归属，不 kill）；证据目录按运行隔离（`.tmp/e2e-bpmn/<runId>/`）并加锁。
- **f1 输入清单自校验**：逐条比对声明与磁盘的 `{bytes, sha256}`，并要求声明集合与独立重建的输入集合完全一致。
- **f2 生命周期**：`saveXML` / `flushProperties` 在 await 后检查生命周期，已销毁的控制器不再返回成功。
- **f3 发布口径**：0.13.4 / 0.13.5 段落里超出证据的表述已按复审结论收窄。

### 测试与验收

- `npm test` 51 个套件、1251 组全过；真浏览器 35 组 / 249 条断言全过。
- `scripts/e2e-bpmn.sh` 在 `dsh-testbed-bpmn` 上实跑通过（含 bootstrap 与「已有实例」两条前置路径），断言 health / 画布 chunk 字节一致 / 定义 / 实例 / 人工任务 / 事件 / 鉴权 / 宿主隔离。

**已知边界**
- 宿主凭据目前只有环境变量与注入 resolver，没有 GUI 凭据管理 / 加密存储 / OAuth 刷新；`networkPolicyId` 由宿主策略表映射，没有 UI 编辑。
- 「旧的 `fs:http.inputMapping/outputMapping` 与 `zeebe:ioMapping` 混用」是在运行到该节点时拒绝，不是保存期门禁。
- 幂等键与调用记录的保护是进程级；同进程 runner 有实例表保护，跨进程并发恢复仍可能各发一次（跨快照恢复窗口见 0.13.7 H5）。
- 主包仍含旧 React Flow（0.14.0 退役）；构建校验对主包只硬禁 BPMN 栈、对 chunk 硬禁 `@xyflow`。

## 0.13.7 — 实例域 worktree 与 0.13.6 复审修复

这一版加**实例级 Git worktree**（Host 侧），并修 0.13.6 复审的 8 MAJOR（H1–H5、N1–N3）+ 4 MINOR 中可复现的部分。随后的复审在 worktree 失败回滚、强制清理、锁与快照上又找到 8 条 MAJOR（W1–W8），并指出 4 条上一轮修复的回归（R1–R4），由 0.13.9 继续收紧——本版的 worktree 清理/回滚语义应视为「可用但未最终封板」。

### 实例域 worktree（新能力）

- **启动契约**：`POST /instances` 支持 `workspace: { path, worktree: { mode:'auto'|'on'|'off', baseRef?, cleanup:'retain'|'on-terminal-clean' } }`。`auto` 在 Git 仓库建树、非 Git 回退原目录；`on` 建树失败即 400；`off` 用原目录。建树发生在第一个 agent 启动之前。
- **身份与冻结**：路径 `<worktreeRoot>/<workspaceId>/<instanceId>`，分支 `flow-instance/<instanceId>`（冲突时 `-2…-20`）；创建时把 `baseRef` 冻结成 `baseCommit`，后续节点/循环/重启都用同一份记录。`workspaceId` 取主仓库身份（origin 归一，linked worktree 与主仓库一致）。
- **运行时一致性**：`agent` 节点 cwd、finish gate 的文档根、消息文件根都来自同一份已解析工作区；worktree 模式下只允许树内相对子目录，绝对路径 / realpath 越界报 `WORKSPACE_CWD_OUTSIDE`；恢复时记录缺失报 `WORKSPACE_UNAVAILABLE`，不静默换回宿主目录。
- **路由**：`GET /instances/<id>/worktree`、`DELETE /instances/<id>/worktree`（`{force, removeBranch, expectedHead?}`）、`DELETE /instances/<id>/worktree/branch`、`GET /instance-worktrees?workspaceId=`、`POST /instance-worktrees/prune`（默认 `dryRun:true`，执行必须带预览的 `planHash`，状态变化后 409 `PLAN_STALE`）、`GET /instances/<id>/resource-events?since=`。只读接口都在测试里验证过**不启动 runner**。
- **清理规则**：`ACTIVE`/`SUSPENDED` 一律 409（`force` 不能越过）；`expectedHead` 不符 409；脏树、未合并分支、目录存在但 Git 未登记分别拒绝；`on-terminal-clean` 只在 agent 进程释放、树干净、产物已保存后执行，失败只写资源事件、不改实例状态；没有所有权证据的目录在 prune 里只报告不删。
- **产物**：按 sha256 寻址的内容快照 `artifacts/<sha256>`，对外仍是 `path + sha256 + bytes`，另加 `executionId/workspaceId/contentRef` 与 `sources[]`（同 path+sha 不重复登记，但保留不同执行来源）。
- **并发**：`execution-limits` 按「实际 agent 执行」占槽（全局/每工作区上限、排队超时、取消退队），人工等待与挂起不长期占槽。
- **记录与事件**：所有权记录 `worktree-registry/<workspaceId>/<instanceId>.json`；实例内冻结快照 `instances/<id>/workspace.json`；资源事件 `instances/<id>/resources/events.jsonl`（独立 `resourceSeq`，执行事件流不动）。

### 0.13.6 复审修复

- **H1 特殊地址分类**：本地 NAT64 前缀（`64:ff9b:1::/48`）、site-local（`fec0::/10`）、benchmark/documentation/orchid/`100::/64` 等默认不再算公网；需要用转换前缀时只能在 `nat64Prefixes` 里显式放行，且内嵌 IPv4 仍要分类为公网。（非 `/96` 前缀的 IPv4 位段提取与 ORCHID `/28` 掩码在 0.13.9 R1 修正。）
- **H2 策略严格校验**：`allowInsecureOrigins` 不再接受 `*` 或省略端口；`allowedCidrs` 的前缀必须是合法数字（`10.0.0.0/` 这种空前缀不再变成 `/0`）；`authOrigins` 必须是严格 origin；非法配置在加载时报 `HTTP_POLICY_INVALID`。
- **H3 凭据回显**：从 `authRef` 解析出的值生成脱敏匹配串（完整值 / scheme 后 token / Basic 解码后的 `user:pass`），白名单响应头命中即 `[redacted]`；输出映射命中直接 `HTTP_RESPONSE_SECRET_LEAK`（不写变量/记录）；`location` 与错误详情递归脱敏；`authRef` 绑定到允许的 origin，跨 origin 使用报 `HTTP_AUTH_ORIGIN_FORBIDDEN` 且零发送。
- **H4 统一 deadline**：入口即建立 deadline，DNS、凭据解析、`beginInvocation`、`recordAttempt` 都参与超时与取消竞争；每次真正发送前再查一次剩余时间，过期零发送；未发送用 `markNotSent` 回滚，不制造假的 unknown。（迟到存储写入与结果提交的期限在 0.13.9 R2 收紧。）
- **H5 恢复幂等**：调用身份改成 `elementId_attempt_N`（attempt 随引擎快照持久化），invocationId、记录键与 `Idempotency-Key` 都基于它；崩溃后恢复同一逻辑激活会复用同一记录与键，不再换键重发。`engineExecutionId` 作为排障元数据保留。
- **N1 实例事务提交**：打开实例时详情 / 任务 / 事件先放本地事务副本，画布应用成功且选择世代仍有效后才在一个同步块里整组提交；失败或过期一律不提交，只把画布恢复到最后一次已提交视图，过期导入不再改写当前实例模型。
- **N2 factory 判定隔离**：校验器在不可信代码执行前冻结所需内建函数，判定结果改走原始字符串通道；factory 里改写 `JSON.stringify` 之类不再能伪造「无问题」结果。
- **N3 e2e 挂载校验**：容器脚本按 `Type/Source/Destination` 三元组校验挂载，拒绝宿主 `HOME` 本身/祖先/`~/.dsh`，拒绝覆盖 `home/profiles/logs/dt/prefix` 的嵌套 bind；用容器内 realpath 校验实际写入路径，并在 `docker cp` / `sed` / `pnpm install` 前复核。（写入子树内部的嵌套 bind 反向检查在 0.13.9 R4 补上。）
- **m1 调用记录处置**：新增 `POST /instances/<id>/connector/<recordId>/resolve`（`mark-succeeded|mark-failed|retry`），只改记录 + 追加 `connector/audit.jsonl` 审计，不推进引擎、不伪造 `activity/end`；重复动作幂等。
- **m2 头部预算**：请求头 64 条 / 单值 8 KiB / 总量 32 KiB，响应头 64 条 / 8 KiB，超限分别报稳定错误码。
- **m3 `ctx.emit` 世代守卫**：handler 的 emit 捕获创建时世代，`stop()`/LRU dispose 后旧 ctx 不再能追加事件。
- **m4 发布口径**：0.13.5 / 0.13.6 段落里超出证据的表述已按复审结论收窄。

### 测试与验收

- `npm test` 56 个套件、1299 组全过；真浏览器 35 组 / 249 条断言全过。
- `scripts/e2e-bpmn.sh` 在 `dsh-testbed-bpmn` 上跑通（0.13.7 版本，含 worktree 相关回归的前置校验）。

**已知边界**
- worktree 的 GUI 面板与 `flow_instance_worktrees` 模型工具在 0.13.8；当前只能通过 HTTP/GUI 的实例列表看到工作区状态（`GET /instances/<id>/worktree`）。
- 宿主凭据 / networkPolicy 仍只有环境变量与注入 resolver；worktree 分支不自动 commit/merge/push。
- H5 的残余窗口：若手工回滚 `state.json` 到更早世代，或同一元素在并行分支同时激活，attempt 可能映射到不同逻辑激活；请求内容不同会以 `HTTP_REQUEST_CONFLICT` 拒绝。H3 只匹配已知凭据值（≥4 字符），不识别再次编码后的回显。
- 幂等与调用记录保护仍是进程级；跨进程并发恢复未做分布式互斥。

## 0.13.9 — worktree GUI/工具与 0.13.7 复审修复

这一版补齐实例 worktree 的 **GUI 与模型工具**，并把 0.13.7 复审的 12 条 MAJOR（W1–W8、R1–R4）修完；另外修掉一个在整套测试里暴露的 abort 竞态（`start` 永不返回时 handler 会挂死）。

### worktree GUI 与工具（0.13.8 内容）

- **实例面板「工作区」区**：模式（worktree / 原目录 / 未配置）、路径、分支、HEAD、dirty 与可清理性；`ACTIVE`/`SUSPENDED` 时清理按钮禁用并给出原因；危险操作在页面内二次确认（可勾选删分支 / 强制），请求带 `expectedHead`。
- **全局「工作树清理」**：打开即 list + `dryRun` 预览，展示将删除 / 保留 / 仅报告清单与 `planHash`；确认后才带 `planHash` 执行；409 `PLAN_STALE` 清掉旧预览并提示重新预览。
- **模型工具** `flow_instance_worktrees({action:'inspect'|'remove'|'branch'|'list'|'prune', instanceId?, workspaceId?, force?, removeBranch?, dryRun?, planHash?, expectedHead?})`：与 HTTP 路由共用同一实现，结果裁剪（长字段 2 KiB / 数组 200 / 深度 8），与 HTTP 共享 runtime 缓存，prune `planHash` 互通。

### 复审修复（W1–W8、R1–R4）

- **W1 创建回滚所有权**：建树全过程加跨进程锁，先建 nonce 临时分支再转正；失败回滚只删「本次 add 成功」或「明确检出本 nonce 分支」的树，分支删除要求 tip 仍等于创建基点，不再发仓库级 prune。
- **W2 locked 不再自动升级**：只有调用者显式 `force:true` 才会 `--force --force`；locked + `force:false` 返回 `INSTANCE_WORKTREE_LOCKED`，自动终态清理同样不升级。
- **W3 分支删除 fail-closed**：只有 `merge-base --is-ancestor` 退出 0 才算证明已合并；空仓库 / 检查异常一律按「未证明已合并」拒绝，显式 force 才删（资源事件标 `forced:true`），删除用 `update-ref -d <ref> <old>` 防 tip 变化。
- **W4 槽位按真实进程退出释放**：runtime 跟踪 adapter 物理执行（start 未返回、迟到句柄未 dispose、dispose 抛错都保持占用），`on-terminal-clean` 等不到释放就跳过并记 `agent-still-running`。
- **W5 allowlist fail-closed**：非法条目（相对路径 / `*` / 非字符串）报 `WORKSPACE_POLICY_INVALID`；「未配置」与「显式空」语义分开，显式空一律拒绝。
- **W6 prune 不碰损坏实例**：实例 JSON 读不出 / 状态非法标 `unknown`，plan 里只报告，执行再拦一次。
- **W7 锁不再误删**：锁内容带 owner token + pid + 心跳；只有 pid 不存在才算 stale，抢占按 inode 复核 + rename 验证，释放要求 owner/inode 一致。
- **W8 快照按内容校验**：已存在的 `artifacts/<sha256>` 必须重算 sha256 完全一致才复用；写入走临时文件 + rename，目标为 symlink / 非普通文件 / 存储根 symlink 一律拒绝。
- **R1 NAT64/ORCHID 位段**：`nat64Prefixes` 只接受 `/96`（RFC 6052 下唯一把 IPv4 放低 32 位的长度），其它长度配置直接 `HTTP_POLICY_INVALID`；ORCHID/ORCHIDv2 改按 `/28` 掩码判断。
- **R2 存储写入世代**：调用记录写入带 generation，迟到写入返回 `HTTP_STORE_STALE`；`recordAttempt` 超时立即在同一记录锁队列排 fence（`markNotSent` 回滚为 `started/attempts=0`），成功 `commitResult` 无宽限、超时明确失败。
- **R3 选择恢复不再反噬**：在飞选择世代集合登记/注销；旧请求过期后安静退出，恢复只在「没有更新选择在途」时执行；当前事务提前返回也会结束 loading。
- **R4 嵌套 bind**：容器脚本只认可 `/testbed` 根 bind，根内嵌套 bind 一律拒绝，根外按双向路径重叠判断，并对实际写入叶（profile/package.json、node_modules、prefix/bin/dsh、日志）做 realpath 校验。
- **m1 墓碑处置**：`resolve` 路由新增 `action:'clear-tombstone'`（必填 evidence，鉴权/审计/幂等沿用），只删墓碑快照、不重放、不伪造事件；错误文案明确 `retry` 只解除记录限制。
- **abort 竞态**：`ctx.signal` 恰好在「入口检查之后、监听注册之前」abort 时，`start` 永不返回会让 handler 永久挂住；现在注册监听后补一次 `aborted` 复查（新增确定性回归测试）。

### 测试与验收

- `npm test` 59 个套件、1334 组全过；真浏览器 35 组 / 249 断言、worktree 面板 7 组 / 33 断言全过。
- `scripts/e2e-bpmn.sh` 在 `dsh-testbed-bpmn` 上跑通（0.13.9，含新的挂载隔离前置）。

**已知边界**
- `nat64Prefixes` 若原来写 `/48` 等长度会在加载时报错（有意的收紧）。
- `clear-tombstone` 后实例仍没有引擎快照，后续 GET 报 `BPMN_STATE_MISSING`，不能自动续跑。
- W4 的物理生命周期跟踪是进程内状态，跨宿主重启的孤儿 agent 进程没有持久化所有权证据。
- 成功 `commitResult` 超时后底层写入可能迟到落成 succeeded；调用方已失败，重试会复用它、不重复发送。

## 0.13.10 — 实例域收件箱 + 复审修复

把「外部消息进得来、agent 回得去」搬进实例域：节点执行期间能收外部消息，agent 也能主动回一条；收件箱有幂等键、正文落盘与体积上限，投递语义按适配器如实标注。同时收掉 0.13.9 复审提出的 9 条发现（F1–F9）。

**实例域收件箱**

- 4 条路由：`POST /instances/<id>/messages` 受理、`GET /instances/<id>/messages` 分页（默认 50 / 上限 100）、`GET /instances/<id>/messages/<messageId>/body` 取回落盘正文、`POST /instances/<id>/messages/<messageId>/replies` 写回复 outbox。
- 幂等：`instanceId + messageId` 加内容指纹；重复投递复用原记录，不重放、不重复注入。
- 体积：正文 ≤ 4 KiB 直接进提示词；更大的落盘到 `inbox/bodies/` 并在提示词里给路径；超过 1 MiB 整条拒绝，一个字节都不写（不截断、不留半截文件）。
- 消息状态机 `queued → injected / resumed / delivered / failed`：投递未确认就不会标成 delivered。每次推进最多取 5 条，剩余条数随结果返回。
- 投递语义按适配器如实暴露：DSH 会话走 `deliverMessage`（宿主回 `deliveryUnknown` 时保持未确认）；codex 适配器明确报「不支持收件箱投递」，不静默丢弃。
- 模型工具 `flow_instance_send_message`、`flow_instance_reply`；实例详情页新增收件箱区块（列表、发消息、回复）。
- 执行收尾摘掉 live 表，未投递完的消息按过期处理，不会在后续会话里补投。

**复审修复（F1–F9）**

- F1 创建失败回滚不再跑仓库级 `git worktree prune`：改为 `rollbackCreatedWorktree` 只撤销本次创建的那一份，缺失路径走定向注销。全仓 prune 会顺带清掉**别的**缺失路径登记，属于误伤。
- F2 合并检查与分支删除用同一个 tip：先捕获 tip、检查合并状态，删除也针对这个 tip（之前「检查的是 A、删的是 B」，能删掉别的实例分支）。
- F3 `DELETE /instances/<id>/worktree` 与 `POST /instance-worktrees/prune` 改看**物理退出确认**：`_activeAgents` 计数、适配器 `cleanup` 标志与进程存活一起判；只看到 CANCELED 状态不再当成「已退出」。codex 适配器补了 cleanup 契约。
- F4 锁协议收紧：抢占前先过 `.steal` guard 串行化，并在 guard 内复核 owner/inode；迟到的 rename 不再把活锁搬走。
- F5 connector 调用记录写盘加 store 级互斥（进程内共享队列 + 跨进程 `.locks` 文件锁），generation 检查在锁内做；旧 fence 不再覆盖新世代的终态。
- F6 过期导入失败不再顶掉最新选择：catch 先判选择世代，过期即安静返回；画布恢复调用带上世代，迟到的旧导入改不动新视图。
- F7 容器 e2e 的挂载隔离检查改成 realpath 双向比对，symlink + 更深 bind 的双重叠组合不再漏判。
- F8 `flow_instance_worktrees` 的 prune 只在显式 `dryRun:false` 时执行；`planHash` 只作计划身份，不再隐含「执行」意图。
- F9 cancel / dispose 有界收口：清理动作超过 `cancelGraceMs` 只记诊断并继续收口，错误对象挂 `cleanupPending / cancelPending / disposePending`；槽位与 `_activeAgents` 仍然只在物理退出确认后释放，不误放。
- 小项：`flow_instance_worktrees` 的计数改用裁剪前真实数量并给 `truncated` 标记（不再把 250 报成 201）；删除确认文案补「未合并提交」提示。

**已知边界**
- 收件箱的「live 表」是进程内状态：宿主重启后，未投递完的消息按过期处理，不会补投。
- cancel / dispose 超时后仍会调 dispose 收口，此时 dispose 可能与尚未返回的 cancel 并发——适配器需要保证 dispose 幂等（内置 DSH / codex 适配器已满足）。
- F1 的定向注销依赖 `git worktree remove <缺失路径>`（git 2.47.3 验证）；更老的 Git 失败时只保留登记，不会退回全仓 prune。
- F4 的锁释放仍是「核对 owner + inode 后 unlink」，跨文件系统 / 网络盘的 inode 语义不保证。
- 实例域工作树的物理存活跟踪是进程内记账，跨宿主重启的孤儿 agent 进程没有持久化所有权证据。

## 0.13.11 — 实例域运行指标

实例域现在能回答「跑了多久、调了多少、卡在谁那儿、错在哪」：单实例与跨实例两套只读接口，加详情面板与列表汇总，口径写进 `design/12`。

- 两条只读路由：`GET /instances/<id>/metrics`（单实例，支持 `?asOf=` 确定性复算）与 `GET /metrics`（跨实例汇总：`definitionId`、`definitionVersion`、`from` / `to`、`status`、`groupBy=day`、`asOf`）。
- 口径：实例墙钟（`createdAt → completedAt/asOf`）、挂起单列、节点按 `executionId` 计时并单列错误 / 取消 / 中断、人工等待（首次 wait → complete/cancel/asOf，**没有新事件也继续增长**）、agent 调用次数（提醒续跑算一次调用，不算新 attempt）、模型调用与 token（`provider + callId` 去重，四桶归一化：input 已含 cache 先拆，reasoning 不另加 total）、`finish_reminder` 逐次计数、`NODE_FINISH_MISSING` 按错误事实 + execution 去重、connector 成功率（execution 级与 attempt 级分列）与两种延迟（单次请求、含退避总耗时）。
- **未知不是零**：没有底层观测时给 `null` 并写 `dataQuality.reasons`，`usageCoverage` 分开记 known / unknown；不把「没看见」写成 0。
- **不双计**：同一 execution 有 `agent/usage` 时忽略 `activity/end.usage`；resume 重放不重置人工等待起点。
- 观测量在调用收尾落账：超时、取消、未 finish 的调用仍保留已观测 usage（不再只从成功的 `activity/end` 取数）。
- 缓存绑 `lastSeq / revision / schemaVersion`（外加 connector、资源指纹），追加事件即失效；`GET` 是纯读，**不启动 runner**，缓存可删可重建。
- 汇总按实例 `createdAt` 选 cohort，遍历 `instances/` 下全部实例（不踩 `listInstances` 默认 limit），分位数从样本合并；损坏实例计入 `skippedInstances`，不中断整张表。
- 没有「完成百分比」：给已执行节点数 / 当前活动 / 等待任务；业务进度只能读显式标量变量，并标注是业务指标。
- GUI：实例详情新增指标区块，列表有汇总；`null` 渲染成「未知 / 无样本」，不给假零。
- 文档：`docs/design/12-instance-metrics.md` 是指标口径唯一来源；`docs/reference/instance-api.md` 新增「运行指标」一节，`host-api.md` 只留旧运行域并指过去。

**已知边界**
- usage 在调用收尾批量落事件：进程硬崩溃会丢尚未 flush 的已观测 token。
- 真实 provider 的 usage 形状用黄金样例与假适配器对齐，容器里没有跑真实 dsh / codex 宿主。
- suspend / resume 还没有公开路由；指标已能处理 `SUSPENDED` 状态与 `instance/suspended|resumed` 事件。
- 不做价格 / 费用推算，也不做固定阈值的健康判决。

**实例域参考文档到位**

- 新增 `docs/reference/instance-api.md`：定义域 + 实例域的全部 HTTP 路由、请求 / 响应字段、错误码与语义口径（状态、收件箱、worktree、connector、资源事件）。`host-api.md` 退回只描述旧运行域并一行指过去，`design/10` 保留设计记录。
- 文档里如实标出「没有的路由」：没有 `GET /instances/<id>/connector` 读取调用记录、没有删除实例、没有 suspend / resume、没有列回复 outbox。
