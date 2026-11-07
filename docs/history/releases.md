# 版本历史（0.1 → 0.9）

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
