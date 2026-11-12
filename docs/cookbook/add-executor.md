# 怎么加一种 agent 适配器（历史：外部执行器）

> **历史资料。** 0.14.0 起旧运行域与它的 `executor`（`dsh` / `codex` / `custom`）已删除；节点不再能通过 `executorCommand` 在宿主 `sh -c` 里执行任意命令。当前只有 AgentAdapter（`dsh` / `codex` / `claude` / `acp`）这条路径，且每个 agent 节点必须调用 `flow_finish_node` 完结。本页只用于追溯旧实现，不要按它改当前代码。

## 当前正确入口

1. 读 [design/09](../design/09-agent-adapter-hooks.md)（适配器 hooks）与 [design/11](../design/11-node-finish-tool.md)（finish 工具契约）。
2. 在 `src/agent-adapter.js` 实现 `probe()` / `capabilities()` / `start()` / `cancel()` / `dispose()`，并保证 `capabilities().finishTool === 'native'`；没有原生 finish 工具的适配器会在 admission 阶段被拒绝。
3. 在 `src/index.js` 的 `buildAgentAdapters()` 注册；注册失败只 warn，不影响插件加载。
4. 适配器必须提供 `flow_finish_node`（dsh 用会话级工具，codex 用 MCP stdio server），并把 finish gate 的 `record` 交给 runtime。
5. 测试参考 `test/agent-adapter-dsh.test.mjs`、`test/agent-adapter-codex.test.mjs`、`test/agent-execute.test.mjs`；不要真调模型，用注入的假适配器。

## 旧实现（仅供回溯）

旧执行链的扩展点是 `src/executor.js` 的 `EXECUTORS` + `normalizeExecutor()` + `runExternalExecutor()`：argv 型（codex）与 shell 型（custom）两套拼装、JSONL 事件消费、进程组超时杀灭、有界输出与脱敏。对应测试 `test/executor.test.mjs`、`test/process-output.test.mjs` 的接线部分已随旧域删除；限额 / 脱敏的纯单元仍保留在 `src/process-output.js`。

旧设计记录：[design/06 §17](../design/06-execution-engine.md)、[design/07 §6](../design/07-runtime-0.7.md)（历史）。
