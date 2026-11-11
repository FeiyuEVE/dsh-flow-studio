# dsh-flow-studio

**DeepSeek Harness 的 BPMN 智能体工作流工作室：用 BPMN 2.0 建模流程，把每个节点交给一个 agent 执行，按实例观察事件、指标与证据。**

在画布里画一条可执行的流程（开始 → 服务任务 / 人工任务 → 结束），给 agent 节点配角色、任务、skill 与适配器；保存成**定义版本**后「运行」生成一个**实例**。实例按 BPMN 引擎推进，agent 节点必须调用 `flow_finish_node` 才能完结；人工任务由人完成；事件、运行指标、业务证据都按实例落盘，可随时查看、取消或清理实例级 worktree。

## 亮点

- **BPMN 2.0 是唯一真相**：流程由 BPMN XML 定义，支持 Zeebe 风格扩展属性（agent / adapter / prompt / team / skills）；XML 导入保留，流程由 `bpmn-engine` 直接执行。
- **定义版本不可变**：每次保存产生一个新版本；实例钉住启动时的定义版本与内容哈希，定义改版不会改写已有实例。
- **实例生命周期**：启动 / 查看 / 事件增量轮询 / 取消；状态只有 `ACTIVE`、`COMPLETED`、`SUSPENDED`、`CANCELED`，执行错误写 `lastError` 而不是伪造 `failed`。
- **人工任务**：`userTask` 进入待办；页面或模型工具 `flow_instance_complete_task` 提交结果后继续流转。
- **agent 节点只走适配器 + 完结门**：`dsh` / `codex` 两种 AgentAdapter；节点会话必须调用 `flow_finish_node` 提交结论与证据，没有旧 executor 的直出回退。
- **运行可观测**：实例事件 append-only 落盘；token / 指标 / 业务证据按独立契约聚合（见 design/12、design/13）。
- **实例级 git worktree**：运行可选独立 worktree，支持 inspect / remove / branch / list / prune，孤儿可单独清理。
- **模板存在本机**：`$DSH_HOME/flow-studio/definitions/` 与 `instances/`，换浏览器、换设备都还在。

## 安装

### 从私源安装（`@feiyueve` scope）

```sh
dsh plugin --profile web add @feiyueve/dsh-flow-studio
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

定义与实例都落在 `$DSH_HOME/flow-studio/`（`definitions/`、`instances/`；目录 0700、文件 0600），没有另外的覆盖变量。落盘布局与字段见 [数据模型](docs/reference/data-model.md)。

## 快速开始

1. **打开画布**：左栏已有出厂模板，也可以「新建」或导入 BPMN XML。选中节点后在属性面板写清 agent 的角色、任务、skill 与适配器。
2. **保存成定义版本**：保存会产生新的定义版本；实例始终钉住启动时的版本。
3. **运行并观察**：点顶栏「运行」创建实例。右侧实例区看状态、待办与详情，底部事件抽屉按 `seq` 增量拉取；指标与证据分别落在独立面板。

## 文档

完整索引与每份文档的读者对象见 [docs/README.md](docs/README.md)。

| 想了解 | 读 |
|---|---|
| 它解决什么、界面怎么用 | [产品指南](docs/guide/overview.md) |
| BPMN 定义 / 实例路由、收件箱、worktree、connector 字段 | [实例域接口](docs/reference/instance-api.md) |
| HTTP 路由、模型工具、鉴权与安全开关 | [Host 接口](docs/reference/host-api.md) |
| 定义 / 实例的数据模型与落盘布局 | [数据模型](docs/reference/data-model.md) |
| 实例事件契约 | [实例 API · 事件](docs/design/10-bpmn-instance-api.md) |
| 实例指标口径 | [实例指标](docs/design/12-instance-metrics.md) |
| 业务证据口径 | [业务证据](docs/design/13-instance-evidence.md) |
| 人工任务完结工具 | [finish 工具](docs/design/11-node-finish-tool.md) |
| 用容器测试台验收一次改动 | [容器测试台](docs/cookbook/run-container-testbed.md) |
| 发一个版本 | [发版](docs/cookbook/release.md) |
| 0.1 → 0.14 每一版改了什么 | [版本历史](docs/history/releases.md) |
| 常见问题 | [FAQ](docs/faq.md) |
| 设计总案与 01–08 分册（历史资料） | [设计总案](docs/DESIGN.md) |

## 开发

```sh
npm install
npm run build   # src/client/entry.js → lib/client.js（主包）+ src/client/bpmn/entry.js → lib/client.bpmn.js（画布 chunk）
npm test        # 构建门禁 + Host / 客户端 / BPMN / 实例域全部自检
```

完整的本机准备、构建校验、测试纪律与发版流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)。第三方依赖及其许可证见 [THIRD-PARTY.md](THIRD-PARTY.md)。
