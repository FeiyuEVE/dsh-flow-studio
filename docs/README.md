# 文档索引

这里是 dsh-flow-studio 的全部人读文档。每份文档只负责一件事；找事实先看「管什么」，再点进去。

## 按任务找

| 我想…… | 读 |
|---|---|
| 弄清这个产品到底解决什么、界面长什么样、画布怎么操作 | [产品指南](guide/overview.md) |
| 不打开画布，在会话里启动流程并让主 agent 自己盯 | [会话驱动](guide/session-driven.md) |
| 往运行中的流程发消息，或理解「一个节点一个会话」 | [收件箱与节点会话](guide/inbox-and-sessions.md) |
| 看指标、打开日志抽屉、导出 run、分清两种闹钟 | [可观测性](guide/observability.md) |
| 查 HTTP 路由、模型工具、令牌与安全开关 | [Host 接口](reference/host-api.md) |
| 查流程 JSON 与 run 目录/元数据字段 | [数据模型](reference/data-model.md) |
| 查事件信封、kind 列表、用量四桶与聚合入口 | [运行日志](reference/run-log.md) |
| 用容器测试台验收一次改动 | [容器测试台](cookbook/run-container-testbed.md) |
| 发一个版本 | [发版](cookbook/release.md) |
| 给节点加一种新的外部执行器 | [加执行器](cookbook/add-executor.md) |
| 看 0.1 → 0.12 每一版改了什么 | [版本历史](history/releases.md) |
| 找常见问题的答案 | [FAQ](faq.md) |
| 看设计总案、01–08 分册与独立审核 | [设计总案](DESIGN.md) · [设计任务书](DESIGN-BRIEF.md) · [分册](design/01-ia-interaction.md) · [审核](design/REVIEW.md) |
| 给这个仓库写文档（人或 agent） | [文档标准](AGENTS.md) |

## 文件地图与职责

| 文件 | 管什么 | 读者 |
|---|---|---|
| [../README.md](../README.md) | 门面：一句话定位、亮点、安装、快速开始、文档导航、开发入口、许可 | 第一次来的人 |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | 本机准备、构建与 `verify-build`、`npm test`、测试纪律、提交规范、发版流程 | 贡献者 |
| [AGENTS.md](AGENTS.md) | 文档标准：一个事实一个家、tutorial / reference 分界、本仓硬约束 | 文档作者与 agent |
| [guide/overview.md](guide/overview.md) | 产品面指南：它解决什么、节点与打回、界面、画布操作、路线图边界 | 使用者 / 评估者 |
| [guide/session-driven.md](guide/session-driven.md) | 在会话里开流程、`flow_*` 工具闭环、工作区与时限 | 在会话里用流程的人 |
| [guide/inbox-and-sessions.md](guide/inbox-and-sessions.md) | 外部消息怎么进流程、一个节点一个会话、回复通道 | 接流程的 agent / 集成方 |
| [guide/observability.md](guide/observability.md) | 指标口径、日志抽屉、导出、节点闹钟与 run 级 supervision 的差别 | 盯运行的人 |
| [reference/host-api.md](reference/host-api.md) | `/api/flow-studio` 路由、模型工具、鉴权、环境变量与安全开关 | 集成方 / 运维 |
| [reference/data-model.md](reference/data-model.md) | 流程 JSON、校验分级、run 目录与 `run.json` 字段、worktree 布局 | 集成方 / 排障 |
| [reference/run-log.md](reference/run-log.md) | 事件契约的入口与速查；契约正文在 [design/05-run-log.md](design/05-run-log.md) | 集成方 / 排障 |
| [history/releases.md](history/releases.md) | 0.1 → 0.12 逐版本变化（README 不再承载历史） | 升级 / 回溯的人 |
| [faq.md](faq.md) | 四个高频问题：顶层会话、worktree、两种闹钟、为什么自研 | 所有人 |
| [cookbook/run-container-testbed.md](cookbook/run-container-testbed.md) | 用 `scripts/e2e-docker.sh` 在容器里端到端验收 | 贡献者 |
| [cookbook/release.md](cookbook/release.md) | build → verify → pack 检查 → publish → 装机对账 | 发版者 |
| [cookbook/add-executor.md](cookbook/add-executor.md) | 加一种外部 executor 的改动面与验证步骤 | 扩展开发者 |
| [postmortem/2026-11-07-oom.md](postmortem/2026-11-07-oom.md) | 2026-11-07 XState 断言把宿主打成 22 GB OOM 的事故记录 | 所有人（尤其写测试的人） |
| [postmortem/2026-11-09-cold-resume-preset.md](postmortem/2026-11-09-cold-resume-preset.md) | 2026-11-09 冷恢复没挂 preset 组合、一个会话掉 31 个工具的事故记录 | 所有人（尤其写投递 / 唤醒路径的人） |
| [DESIGN.md](DESIGN.md) | 设计仲裁层：定位、视觉方向、布局、三个核心语义、冲突裁决表、验收口径 | 设计与实现者 |
| [DESIGN-BRIEF.md](DESIGN-BRIEF.md) | 最初的设计任务书（历史输入，不再更新） | 想理解设计来源的人 |
| [design/01–08 + REVIEW.md](design/01-ia-interaction.md) | 分册数值规格与独立审核；**编号与内容冻结**，只允许改指向 README 的引用 | 实现者 / 审核者 |

## 读文档的顺序

- **第一次接触**：`../README.md` → [guide/overview.md](guide/overview.md) → 想接流程再看 [guide/session-driven.md](guide/session-driven.md)。
- **要接 API**：[reference/host-api.md](reference/host-api.md) → [reference/data-model.md](reference/data-model.md) → [reference/run-log.md](reference/run-log.md)（契约正文在 design/05）。
- **要改代码**：[../CONTRIBUTING.md](../CONTRIBUTING.md) → [docs/AGENTS.md](AGENTS.md) → 相关分册。
- **要发版**：[cookbook/release.md](cookbook/release.md)，验收用 [cookbook/run-container-testbed.md](cookbook/run-container-testbed.md)。

## 维护约定

- 事实只有一个家；发现两处冲突，先定 owner，另一处改成链接。层级划分见 [AGENTS.md](AGENTS.md)。
- 事件契约的唯一真相源是 [design/05-run-log.md](design/05-run-log.md)；[reference/run-log.md](reference/run-log.md) 只做入口与速查。
- 版本历史只进 [history/releases.md](history/releases.md)，README 不写版本历史。
- 相对链接必须能打开；改文件名前先全仓搜链接。
