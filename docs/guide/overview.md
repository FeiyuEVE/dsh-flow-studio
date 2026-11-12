# 产品指南：它解决什么

dsh-flow-studio 是 DeepSeek Harness 的 **BPMN 智能体工作流工作室**：在 Web 画布上画一条可执行的 BPMN 流程，把服务任务配成 agent（可带团队）、把人工确认配成 `userTask`；保存成定义版本后「运行」生成实例，引擎按 BPMN 语义推进，事件、指标与证据按实例落盘。

它不是一个只会画图的编辑器：定义是**可执行契约**，实例是**可观察事实**。agent 节点必须调用 `flow_finish_node` 提交结论与证据才能完结；执行失败写进 `lastError`，不伪造状态；每个实例都钉住启动时的定义版本，改定义不会改写历史。

## 它解决什么

```
开始 → 需求分析(agent) → 方案设计(agent) → 人工确认(userTask) → 开发(agent) → 结束
```

- **定义即 BPMN**：流程是 BPMN 2.0 XML，支持 Zeebe 风格扩展属性（agent 类型、adapter、prompt、team、skills）。XML 导入保留；画布由 BPMN Modeler + 属性面板驱动。
- **定义版本不可变**：每次保存产生新版本；实例启动时钉住 `definitionVersion + definitionHash` 并复制定义快照。定义改版只影响之后启动的实例。
- **agent 节点只走适配器 + 完结门**：`dsh` / `codex` / `claude` / `acp` 四种 AgentAdapter。节点会话必须调用 `flow_finish_node`；没有调用就失败（`NODE_FINISH_MISSING`），不存在旧 executor 的直出回退。
- **人工任务**：`userTask` 进入 `pendingTasks`；页面或模型工具完成待办后继续流转。人工等待不是实例状态。
- **实例状态只有四个**：`ACTIVE` / `COMPLETED` / `SUSPENDED` / `CANCELED`；执行错误用 `lastError` 表达。
- **运行可观测**：事件按 `seq` 增量拉取；指标与业务证据分别按 [design/12](../design/12-instance-metrics.md)、[design/13](../design/13-instance-evidence.md) 聚合，未知一律不是零。
- **实例级 worktree**：可选独立 git worktree；支持 inspect / remove / branch / list / prune。
- **模板存在本机**：`$DSH_HOME/flow-studio/definitions/<id>/`，换浏览器、换设备都还在。

## 界面

| 区域 | 做什么 |
|---|---|
| 左侧 | 定义列表：新建 / 打开 / 导入 BPMN XML；列表显示定义版本摘要（定义不可删除） |
| 中间 | BPMN 画布：拖拽节点、连线、缩放 / 平移；右侧官方属性面板配 agent / 人工任务 / 表单 / connector 等属性 |
| 右侧 | 实例区：实例列表、详情、人工待办（可挂起 / 恢复 / 停止实例）、指标 / 证据 / 收件箱 / worktree 面板 |
| 底部 | 实例事件抽屉：按 `seq` 增量拉取，可查看每条事件的 kind、时间与摘要 |

## 画布怎么用

- **建模**：用官方 BPMN 元素（开始 / 结束事件、serviceTask、userTask、网关、子流程、边界事件）组合流程；给 serviceTask 配 `fs:node nodeType="agent"` 与 adapter / prompt / team / skills。
- **agent 属性**：节点 type=agent 时属性面板出现 adapter、prompt、team、skills、人工确认与变量映射；具体字段以 [实例域接口](../reference/instance-api.md) 与 [design/10](../design/10-bpmn-instance-api.md) 为准。
- **保存**：保存产生新的定义版本，不做原地覆盖；实例不会因为定义改版而被重写。
- **运行**：保存后点「运行」创建实例。运行中的实例是只读视图；要看结构就打开对应定义版本。

## 当前边界

- 实例状态没有 `failed` / `blocked`：失败是 `lastError`，人工等待是 `pendingTasks`，挂起是 `SUSPENDED`。
- 挂起是软挂起：不杀执行器、不做新快照、**不暂停计时器**（挂起期间活动超时照常发生，并留下错误事实），恢复不会自动继续跑。什么时候可以挂起、挂起期间哪些操作会被拒，见 [实例域接口 · 挂起 / 恢复](../reference/instance-api.md#挂起与恢复)。
- 不提供旧运行域的 supervision / 节点闹钟 / 打回状态机 / 外部 executor；业务循环用普通 `sequenceFlow` + FEEL 条件建模。
- 旧 `/flows`、`/runs`、`/worktrees` 路由已删除，已认证请求返回 404；磁盘上的旧数据不再加载。
- 实时多人协同、图中图、数据库式历史迁移不在当前范围。

## 延伸阅读

- 实例工具与运行方式：[会话驱动](session-driven.md)
- 收件箱与节点会话：[收件箱与节点会话](inbox-and-sessions.md)
- 指标、证据与事件抽屉：[可观测性](observability.md)
- 契约：[实例域接口](../reference/instance-api.md) · [data-model](../reference/data-model.md) · [design/10](../design/10-bpmn-instance-api.md)
