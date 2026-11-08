# dsh-flow-studio

**DeepSeek Harness 的智能体工作流编排工作室：把一条研发流水线画成图，每个节点是一个 agent，能配、能盯、能被打回。**

在画布上拖出「需求分析 → 方案设计 → 结构设计 → 开发 → 测试 → 代码审查」，给每个节点配角色、任务、skill 与执行方式；点「运行」就能看到它跑到哪、卡在哪、被打回几次、花了多少 token，跑完给出确定性的质量结论。流程模板保存在本机，随时打开继续改。

## 亮点

- **一个节点就是一个 agent**：单个 agent，或「主管 + 3 个子 agent」；角色、任务、skill、模型覆盖都在检查器里配，主从模式下逐个配成员分工。
- **打回是图的一部分**：打回线指向任意上游节点并自动构成循环，走画布下方的正交航道，不挤占正常流转的视觉空间；每个节点可单独设打回上限。
- **运行态叠在设计态上**：运行期间结构冻死、只读观察，状态用「颜色 + 角标 + 线型」多通道叠加，缩到 60% 仍能认出哪一步被打回。
- **过程可盯，结论不靠自证**：run 事件落 append-only JSONL；token / skill 覆盖率 / findings / 打回 / 进度全部确定性聚合，质量结论要求五类证据齐全且至少一条独立复核，缺证据一律「未检测」。
- **节点可换外部 executor**：`dsh` / `codex` / `custom`；过程输出映射成节点日志与用量，判定仍走同一份 `outputSchema`。外部 executor 只允许 single，非法配置能保存、不能开跑。
- **能在会话里开跑**：`flow_start` 在任意会话里启动一个 run 并自动开启内建 supervision，主 agent 到点自己醒来 `flow_watch` 复查，不用去画布点运行。
- **流程能收外部消息**：`flow_send_message` / `flow_reply` + HTTP 收件箱，一个节点始终只有一个会话。
- **模板存在本机**：`$DSH_HOME/flow-studio/flows/`，换浏览器、换设备都还在。

## 安装

### 从私源安装（`@feiyueve` scope）

```sh
dsh plugin --profile web add @feiyueve/dsh-flow-studio@0.9.4
```

### 从源码安装

```sh
git clone git@github.com:FeiyuEVE/dsh-flow-studio.git
cd dsh-flow-studio
npm install
npm run build
dsh plugin --profile web add ./dsh-flow-studio
```

装完刷新页面，侧栏出现「流程编排」图标。Host 半边（路由）需要重启 `dsh web` 才挂载。

流程与 run 都落在 `$DSH_HOME/flow-studio/`（`flows/`、`runs/`、`worktrees/`；目录 0700、文件 0600），没有另外的覆盖变量。落盘布局与字段见 [数据模型](docs/reference/data-model.md)。

## 快速开始

1. **打开画布**：左栏已有出厂模板（六阶段主干 + 四条打回线），也可以「新建」从空白开始。双击空白处加节点，从节点右侧圆点拖到另一个节点建连线。
2. **配节点**：选中节点，在右侧检查器写清「它是什么人」（角色定位）与「它负责什么」（任务），按需勾 skill、改执行方式、设打回上限。
3. **运行并盯住**：点顶栏「运行」——结构校验不过会跳到第一条问题；底栏显示节点 / 连线 / 打回统计与保存状态，底部抽屉看 run 列表、事件流、token 与质量结论。也可以不点画布：在会话里 `flow_start`，让主 agent 自己盯（见 [会话里开流程](docs/guide/session-driven.md)）。

## 文档

完整索引与每份文档的读者对象见 [docs/README.md](docs/README.md)。

| 想了解 | 读 |
|---|---|
| 它解决什么、界面与画布怎么用 | [产品指南](docs/guide/overview.md) |
| 在会话里开流程，让主 agent 自己盯着 | [会话驱动](docs/guide/session-driven.md) |
| 流程收外部消息、一个节点只有一个会话 | [收件箱与节点会话](docs/guide/inbox-and-sessions.md) |
| 指标、日志抽屉、导出、两种闹钟的差别 | [可观测性](docs/guide/observability.md) |
| HTTP 路由、模型工具、权限与安全开关 | [Host 接口](docs/reference/host-api.md) |
| 流程与 run 的数据模型 | [数据模型](docs/reference/data-model.md) |
| 事件契约速查 | [运行日志](docs/reference/run-log.md) |
| 用容器测试台验收一次改动 | [容器测试台](docs/cookbook/run-container-testbed.md) |
| 发一个版本 | [发版](docs/cookbook/release.md) |
| 给节点加一种新的外部执行器 | [加执行器](docs/cookbook/add-executor.md) |
| 0.1 → 0.9 每一版改了什么 | [版本历史](docs/history/releases.md) |
| 常见问题（会话、worktree、闹钟、为什么自研） | [FAQ](docs/faq.md) |
| 设计总案与 01–08 分册（数值与裁决） | [设计总案](docs/DESIGN.md) |
| 文档怎么写、事实放哪一层 | [docs/AGENTS.md](docs/AGENTS.md) |

## 开发

```sh
npm install
npm run build   # src/client/entry.js → lib/client.js（单文件）+ 复制 Host 模块
npm test        # 28 个自检文件（含发布门禁）；27 个功能套件共 992 组
```

完整的本机准备、构建校验、测试纪律（含 XState 内存事故）与发版流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)。第三方依赖及其许可证见 [THIRD-PARTY.md](THIRD-PARTY.md)。
