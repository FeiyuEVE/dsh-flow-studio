# 常见问题

每个答案只保留最短的结论与出处；细节在各自的 owner 文档里。

## 为什么节点会话能在会话列表看到？它不是「子 agent」吗？

v0.7 起节点主管会话走 `ctx.agents.create`，是**顶层会话**：session header 里没有 `parentSession` / `origin`，`delegationDepth: 0`，所以 Web 侧栏能看到、能点开接管。`team` 节点的成员才是主管委派出的子会话（header 带 `parentSession` / `origin:'subagent'`）。

判断是否顶层**看 session header，不看 `roots()`**——`resume` 之后 agent 在运行时也是 root，但持久化血缘不变。run 收尾的 `dispose()` 只关句柄、不删日志，会话仍在列表（`agentAvailable:false`）、磁盘文件仍在、之后仍可 `resume`。只 `create` 不跑 turn 的 `blank` 会话 API 有、Web 侧栏看不到；节点会话一定会跑 turn，不受影响。

细节与设计理由：[收件箱与节点会话 § 节点会话是顶层会话](guide/inbox-and-sessions.md#节点会话是顶层会话)。

## worktree 建在哪？为什么不自动删？

`worktree.enabled=true` 时根是 `$DSH_HOME/flow-studio/worktrees/<workspaceId>/<runId>`，分支 `flow/<runId>`（重名依次 `-2`…），base 取工作区 `HEAD`；节点会话与外部 executor 的 `cwd` 都用这份副本。

run 收尾**不自动删**：用户可能还要进去看产物、跑测试。删除只走 `removeWorktree()`：先校验路径必须落在 `<root>/<workspaceId>/` 下，再执行 `git -C <workspace> worktree remove [--force] <path>`。0.8.2 起有 HTTP 与模型工具入口（`DELETE /runs/<id>/worktree`、`POST /worktrees {action:'prune'}`、`flow_worktrees`），并连 `flow/` 前缀分支一起回收。`auto` 策略下建失败会如实写 `enabled:false, reason:'create-failed: …'`，不会假装已隔离。

路径、孤儿判定与清理顺序：[数据模型 § Worktree](reference/data-model.md#worktree)。

## 节点闹钟和 run 级 supervision 有什么区别？

一句话：**run 级叫醒发起会话、问「整条流水线还好吗」；节点闹钟叫醒节点主管会话、问「你这个节点现在什么状态」**。两者回报的落点不同（`run.json.supervision` vs `node/status` 事件 + `run.json.nodeStatus` + `live.nodeStatus`），节奏不同（180s / 60s / 30s 分档 vs 默认 600s），停止条件也不同。它们在 `createRuntime()` 里各自创建、各自一个 `setInterval`、各自一份状态，**不是同一个 tick**；节点闹钟的登记在 0.8.2 起可跨重启恢复，但两个调度器的计数仍是内存态。自审说 `done` 只是「提前完成信号」，会与 `whenIdle` 竞速（采用时 `completedBy='self-check'`），**不能**替代结构化 verdict 的合法性检查；外部 executor 节点没有会话，不挂闹钟。

完整对比表与重启恢复规则：[可观测性 § 节点闹钟与 run 级 supervision](guide/observability.md#节点闹钟与-run-级-supervision)。

## 为什么自研，不用现成的画布插件？

新建插件前按 `PLUGIN-SEARCH.md` 先搜过一轮，留痕如下（2026-11-06）：

- **形态关键词**：`dsh workflow / canvas / graph / orchestration` + `reactflow` / `react-flow`，GitHub 仓库搜索命中 587 / 203 / 271 / 199 条；代码搜索 `"dsh.bundle" filename:package.json + canvas` 命中 2 条、`"reactflow" filename:package.json dsh` 命中 50 条；npm `dsh workflow|graph|orchestration` 逐条看过包名。
- **最接近的候选**：
  - `GZX2211/dsh-Visual-Workflow`（★64，MIT，v0.10.3）——画布 + 节点级角色 + 主从多 agent 三件齐备，缺打回状态机与指标看板；仓库 40.8MB / 1536 文件，依赖 `@huggingface/transformers` → onnxruntime-node / sharp，`peerDependencies` 全是 `*`。
  - `chumingjun/dsh-harness-one`（★31）——React Flow 画布 + 8 类节点，但无主从编排、不声明 peer/engines。
  - `CodermanYHZ/dsh-node-flow`（★15）——最小画布骨架（`@xyflow/react` + zustand），2026-08 后停更。
  - `toolclub/dsh-agent-team-gui`（★288）——主从 + Run Center 指标最好，但无画布、peer 钉在 0.1.5 旧世代。
  - `miuzel/dsh-graph`（★25）——状态机 + 泳道看板那一半的现成范本，不是编排画布。
- **结论：自研**。理由：没有一个候选同时覆盖「画布 + 节点角色 + 主从 + 打回状态机 + 指标」；最接近的 Visual-Workflow 体量大、带原生编译依赖、且它的「回流重试」是节点级重试而不是显式的打回连边，要在 1536 个文件里再加两层（打回状态机 + 指标看板），代价高于按本仓的零依赖实现重写。
- **从候选里借的是思路**：画布与检查器分离、节点级角色 / 模型覆盖、按 upstream 判打回方向。内置 `workflow` 工具（脚本编排 subagent）与 `dsh-advisor-flow`（会话级顾问）都不覆盖可视化与状态机。
