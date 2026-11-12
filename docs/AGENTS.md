# AGENTS.md — 本仓文档标准

给在这个仓库写文档的人与 agent。规则要能直接执行：先定位事实的家，再决定写成教程还是参考，最后检查链接与冲突。

## 1. 一个事实一个家

同一件事只在一处写全，其它地方链接过去。文件树的位置决定它能写多细：只写自己主题该有的细节，子主题的细节交给子文档并链接。

| 层 | 管什么 | 不该写什么 |
|---|---|---|
| [../README.md](../README.md) | 门面：一句话定位、亮点、安装（私源 + 源码）、快速开始、文档导航、开发入口、许可 | 版本历史、字段表、排障长文、设计数值 |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | 本机准备、构建与发布前校验、`npm test`、测试纪律、提交规范、发版流程 | 用户可见行为、HTTP 字段表、设计裁决 |
| [README.md](README.md)（本文档目录索引） | 文档地图：每份文档一句话职责 + 读者对象 + 推荐阅读顺序 | 任何事实细节 |
| [guide/](guide/overview.md) | 产品面指南：用户能看到什么、怎么操作、行为是什么 | 路由表、字段级契约、内部实现细节 |
| [reference/](reference/host-api.md) | 契约：路由、参数、字段、环境变量、错误码、落盘布局 | 教学顺序、设计理由、「为什么这么定」 |
| [history/releases.md](history/releases.md) | 逐版本变化（0.1 → 0.13.x）：新增、修复、已知边界 | 当前行为（当前行为归 guide / reference） |
| [faq.md](faq.md) | 高频问题的**短答案 + 指向 owner 的链接** | 与 owner 重复的长篇解释 |
| [cookbook/](cookbook/release.md) | 编号步骤式 how-to，每步带可验证结果 | 设计理由、字段全表 |
| [postmortem/](postmortem/2026-11-07-oom.md) | 事故记录体例：现象、时间线、根因链、修复、遗留 | 常规教程 |
| [DESIGN.md](DESIGN.md) | **历史资料**：旧运行域时代的设计总案（定位、视觉方向、布局、打回 / executor、冲突裁决表）；0.14.0 起冻结 | 当前契约（归 design/09–14 与 reference/instance-api.md） |
| [DESIGN-BRIEF.md](DESIGN-BRIEF.md) | 最初的设计任务书（历史输入，冻结） | 现行裁决 |
| [design/01–08 + REVIEW.md](design/01-ia-interaction.md) | **历史资料**：旧运行域时代的分册数值规格、接口契约、审核记录（0.14.0 起不更新） | 当前实例域契约（归 design/10–13） |
| [design/09–14](design/10-bpmn-instance-api.md) | 当前契约：agent 适配器 hooks（09）、BPMN 实例 API / 事件（10）、finish 工具（11）、实例指标（12）、业务证据（13）、ACP 适配器（14） | 旧运行域行为 |
| [AGENTS.md](AGENTS.md)（本文件） | 文档分层税则与写作规则 | 产品事实、版本历史 |

## 2. 事实 → 归哪个 tier（查这张表再动笔）

| 你要写的事实 | 家 | 反例 |
|---|---|---|
| 这个产品是什么、有哪些亮点 | `../README.md` | 把 8 条修复明细塞进 README |
| 装它、跑它 | `../README.md`（安装 + 快速开始三步） | 在 README 里写发版流程 |
| 开发命令、构建产物、测试纪律 | `../CONTRIBUTING.md` | 在 README 里列 17 个测试文件 |
| 「发一个版本」的步骤 | `cookbook/release.md`（CONTRIBUTING 只留一句摘要与链接） | cookbook 里写测试口径 |
| 用户点哪里、看到什么、行为如何 | `guide/` | guide 里贴 `instance.json` 字段表 |
| HTTP 路由 / 模型工具 / 环境变量 / 错误码 | `reference/host-api.md` | 在 guide 里维护路由表 |
| 定义版本、`instance.json`、目录布局 | `reference/data-model.md` | 在 README 里保留第二份 schema |
| 当前实例事件 kind 与字段定义 | **`design/10-bpmn-instance-api.md`（唯一真相源）**；旧 run 事件只在 `design/05` 与 `reference/run-log.md` 作历史资料 | 把 10 的事件表复制到 guide / reference |
| 当前指标 / 证据口径 | `design/12-instance-metrics.md` / `design/13-instance-evidence.md` | 在 reference 里写第二套阈值或判定表 |
| 某一版的改动 | `history/releases.md` | README 里写「当前版本：0.9.0 + 各版历史」 |
| 当前实例指标 / 证据数值（阈值、聚合口径） | `design/12–13`；旧界面数值在 `DESIGN.md` 与 `design/01–08`（**历史资料，0.14.0 起冻结**） | guide 里写像素值或阈值形成第二真相 |
| 旧设计数值冲突的历史裁决 | `DESIGN.md` §6（只解释 0.14.0 之前的选择，不再是现行裁决依据） | 拿历史裁决表给当前实现定数 |
| 为什么这么设计 / 否决了什么 | 当前契约的理由写在 `design/09–14`；旧运行域的 `DESIGN.md` §1–§5 与 `design/01–08` 只作历史资料 | 在 reference 里讲心路历程 |
| 事故与教训 | `postmortem/`（唯一允许讲故事的 tier） | 在测试注释里写完整事故报告 |
| 高频疑问 | `faq.md`（短答案 + 链接） | FAQ 里复制整段契约 |

判断标准：**把这段文字搬到另一个文件里，会不会立刻产生第二个真相源？** 会，就改成链接。

## 3. tutorial 与 reference 的分界

- **tutorial（教程）**：读者按顺序走，能到达一个结果。只引入下一步马上要用的概念，前置先于依赖，难度递增。`guide/` 与 `cookbook/` 按这个写：cookbook 必须编号步骤，每步写清「做什么 → 怎么验证」。
- **reference（参考）**：定义查询范围与当前行为，不承担教学顺序，可以对自己的主题穷尽。`reference/` 与 `design/` 分册按这个写。
- 一份文档里两种内容都占相当篇幅时，拆成两份；只占一小节时，用标题标出「本节是教程 / 本节是参考」，不要混着写。
- 教程里不复制契约表：需要字段时链接到 owner，最多留一个最小的输入示例。
- 参考里不写「先做 A 再做 B」的步骤；步骤归 cookbook。

## 4. 本仓硬约束

1. **`design/` 分册冻结**：`01-ia-interaction.md` … `08-state-machine.md`、`REVIEW.md` 自 0.14.0 起是**历史资料**，文件名与编号不许重排、不许改名、不许按新域重写；只允许加「历史资料」标注或修失效链接。`09–14` 是当前契约，可以随实现更新。
2. **当前实例事件 / 指标 / 证据的唯一真相源分别是 `design/10-bpmn-instance-api.md`、`design/12-instance-metrics.md`、`design/13-instance-evidence.md`**。旧 `design/05-run-log.md` 只解释历史 run 事件；`reference/run-log.md` 的旧事件速查同样只作历史资料，不再描述当前实例事件。其它文档只写「契约在哪、怎么用、字段速查」，详细字段、校验规则、聚合口径一律链接过去，不复制。
3. **README 不写版本历史**。历史只进 `history/releases.md`；README 的文档导航给一个入口。
4. **`DESIGN.md` 自 0.14.0 起是历史资料，不再更新、也不再是现行冲突裁决依据**（§6 裁决表只解释旧运行域时代 01–08 分册的选择）。当前契约以 `design/09–14` 与 `reference/instance-api.md` 为准；旧分册出现旧值时保留原文并标注历史，不要在两处各留一套现行值。
5. **一个事实一个家**：新写一段前先搜关键字（比如 `FLOW_STUDIO_TOKEN`、`instance.json`），已有家就链接，不新开第二节。
6. **链接必须通**：一律用相对链接；改文件名或移动目录后，全仓扫一遍 `](` 引用。跨文件锚点按 GitHub slug 规则（小写、空格转 `-`、去标点），中文标题保留中文字符。
7. **只描述当前行为**：历史用版本号或日期限定（如「0.8.2 起」）；不写「未来会」「已实现！」这类会腐烂的状态标注，交付状态归 `history/releases.md`。
8. **文档不动代码**：改文档的提交不顺手改 `src/`、`test/`、`scripts/`、`package.json`、`LICENSE`、`THIRD-PARTY.md`、`cordis.patch.yml`、`locale/`。

## 5. 写作规则

- 一段一行（源文件里一个段落占一行，靠编辑器软换行显示）；代码块、表格、列表保持原有结构。
- 中文为主；术语固定：**定义**、**定义版本**、**实例**、**活动**、**人工任务**、**实例事件**、**收件箱**、**实例 worktree**。旧术语（**run**、**打回**、**supervision**、**节点闹钟**）只允许出现在历史资料里。英文标识符（`flow_instance_run`、`FLOW_STUDIO_TOKEN`）保持原文。
- 强调只给会改变行为的子句；整段加粗等于没有强调。
- 例子优先用真实值（默认 2h / 20min、600s、6 槽、15% 地板）；不给数字的地方就不要含糊地说「比较大」。
- 外部引用给可点开的 URL，并写清「借了哪一点」；不写「参考了很多资料」。
- 文档标题层级：每份文档一个 H1；H2 是主要章节；H3 只在确实有子结构时用。

## 6. 改文档前的三问

1. 这个事实现在住在哪？搜一下，别复制。
2. 它属于教程还是参考？读者是使用者、集成方、贡献者还是发版者？
3. 我这条链接指到的文件与锚点在移动后还存在吗？
