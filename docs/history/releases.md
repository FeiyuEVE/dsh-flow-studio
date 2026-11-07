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
