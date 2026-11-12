# 文档索引

这里是 dsh-flow-studio 的全部人读文档。每份文档只负责一件事；找事实先看「管什么」，再点进去。

## 按任务找

| 我想…… | 读 |
|---|---|
| 弄清这个产品到底解决什么、界面长什么样、画布怎么操作 | [产品指南](guide/overview.md) |
| 在会话或页面里启动实例、完成人工任务、看事件 | [会话驱动](guide/session-driven.md) |
| 往运行中的实例发消息，或理解「一个节点一个会话」 | [收件箱与节点会话](guide/inbox-and-sessions.md) |
| 看实例指标、事件抽屉、业务证据 | [可观测性](guide/observability.md) |
| 查 HTTP 路由、模型工具、令牌与安全开关 | [Host 接口](reference/host-api.md) |
| 查 BPMN 定义 / 实例域的路由、收件箱、worktree 与 connector 字段 | [实例域接口](reference/instance-api.md) |
| 查定义 / 实例目录与元数据字段 | [数据模型](reference/data-model.md) |
| 查旧 run 事件（历史资料） | [运行日志](reference/run-log.md) |
| 用容器测试台验收一次改动 | [容器测试台](cookbook/run-container-testbed.md) |
| 发一个版本 | [发版](cookbook/release.md) |
| 给节点加一种新的 agent 适配器（历史：旧外部执行器） | [加执行器](cookbook/add-executor.md) |
| 看 0.1 → 0.14.x 每一版改了什么 | [版本历史](history/releases.md) |
| 找常见问题的答案 | [FAQ](faq.md) |
| 看历史设计总案、01–08 分册与独立审核（历史资料） | [历史设计总案](DESIGN.md) · [设计任务书](DESIGN-BRIEF.md) · [分册](design/01-ia-interaction.md) · [审核](design/REVIEW.md) |
| 给这个仓库写文档（人或 agent） | [文档标准](AGENTS.md) |

## 文件地图与职责

| 文件 | 管什么 | 读者 |
|---|---|---|
| [../README.md](../README.md) | 门面：一句话定位、亮点、安装、快速开始、文档导航、开发入口、许可 | 第一次来的人 |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | 本机准备、构建与 `verify-build`、`npm test`、测试纪律、提交规范、发版流程 | 贡献者 |
| [AGENTS.md](AGENTS.md) | 文档标准：一个事实一个家、tutorial / reference 分界、本仓硬约束 | 文档作者与 agent |
| [guide/overview.md](guide/overview.md) | 产品面指南：它解决什么、节点与打回、界面、画布操作、路线图边界 | 使用者 / 评估者 |
| [guide/session-driven.md](guide/session-driven.md) | 在会话里启动 / 查看 / 取消实例、完成人工任务 | 在会话里用实例的人 |
| [guide/inbox-and-sessions.md](guide/inbox-and-sessions.md) | 外部消息怎么进实例、一个节点一个会话、回复通道 | 接实例的 agent / 集成方 |
| [guide/observability.md](guide/observability.md) | 实例指标口径、事件抽屉、业务证据 | 盯实例的人 |
| [reference/host-api.md](reference/host-api.md) | `/api/flow-studio` 路由、模型工具、鉴权、环境变量与安全开关 | 集成方 / 运维 |
| [reference/instance-api.md](reference/instance-api.md) | BPMN 定义 / 实例域路由、实例状态、收件箱、worktree、connector 与实例工具 | 集成方 / 排障 |
| [reference/data-model.md](reference/data-model.md) | 定义版本、实例目录与 `instance.json` 字段、worktree 布局；旧 run 数据只说明历史 | 集成方 / 排障 |
| [reference/run-log.md](reference/run-log.md) | **历史资料**：旧 run 事件契约速查；当前实例事件以 [design/10](design/10-bpmn-instance-api.md) 为准 | 回溯旧数据的人 |
| [history/releases.md](history/releases.md) | 0.1 → 0.14.x 逐版本变化（README 不再承载历史） | 升级 / 回溯的人 |
| [faq.md](faq.md) | 高频问题：实例 worktree、实例状态、旧数据边界、为什么 BPMN | 所有人 |
| [cookbook/run-container-testbed.md](cookbook/run-container-testbed.md) | 用 `scripts/e2e-bpmn.sh` 在容器里端到端验收 | 贡献者 |
| [cookbook/release.md](cookbook/release.md) | build → verify → pack 检查 → publish → 装机对账 | 发版者 |
| [cookbook/add-executor.md](cookbook/add-executor.md) | **历史资料**：旧外部 executor 的改动面；当前请改 AgentAdapter | 扩展开发者 |
| [postmortem/2026-11-07-oom.md](postmortem/2026-11-07-oom.md) | 2026-11-07 XState 断言把宿主打成 22 GB OOM 的事故记录 | 所有人（尤其写测试的人） |
| [postmortem/2026-11-09-cold-resume-preset.md](postmortem/2026-11-09-cold-resume-preset.md) | 2026-11-09 冷恢复没挂 preset 组合、一个会话掉 31 个工具的事故记录 | 所有人（尤其写投递 / 唤醒路径的人） |
| [DESIGN.md](DESIGN.md) | **历史资料**：旧运行域时代的设计总案（定位、视觉方向、布局、打回 / executor、冲突裁决表）；0.14.0 起冻结，不再作为现行契约 | 想理解旧设计决策的人 |
| [DESIGN-BRIEF.md](DESIGN-BRIEF.md) | 最初的设计任务书（历史输入，不再更新） | 想理解设计来源的人 |
| [design/01–08 + REVIEW.md](design/01-ia-interaction.md) | 旧运行域时代的分册数值规格与独立审核（**历史资料，编号与内容冻结**） | 想理解旧设计的人 |
| [design/09–13](design/10-bpmn-instance-api.md) | 当前契约：适配器 hooks、BPMN 实例 API、finish 工具、实例指标、业务证据 | 实现者 |
| [design/14](design/14-acp-adapter.md) | ACP 适配器：决策、连接 / 会话生命周期、probe 四层证据、完结与提醒、权限、清理与取消、错误索引与明确不做 | 接 ACP agent 的实现者 / 验收者 |

## 读文档的顺序

- **第一次接触**：`../README.md` → [guide/overview.md](guide/overview.md) → 想接流程再看 [guide/session-driven.md](guide/session-driven.md)。
- **要接 API**：[reference/host-api.md](reference/host-api.md) → [reference/instance-api.md](reference/instance-api.md) → [reference/data-model.md](reference/data-model.md)（事件契约在 design/10）。
- **要改代码**：[../CONTRIBUTING.md](../CONTRIBUTING.md) → [docs/AGENTS.md](AGENTS.md) → 相关分册。
- **要发版**：[cookbook/release.md](cookbook/release.md)，验收用 [cookbook/run-container-testbed.md](cookbook/run-container-testbed.md)。

## 维护约定

- 事实只有一个家；发现两处冲突，先定 owner，另一处改成链接。层级划分见 [AGENTS.md](AGENTS.md)。
- 当前实例事件契约的唯一真相源是 [design/10-bpmn-instance-api.md](design/10-bpmn-instance-api.md)；[design/05-run-log.md](design/05-run-log.md) 与 [reference/run-log.md](reference/run-log.md) 只作历史资料（旧 run 事件）。
- 版本历史只进 [history/releases.md](history/releases.md)，README 不写版本历史。
- 相对链接必须能打开；改文件名前先全仓搜链接。
