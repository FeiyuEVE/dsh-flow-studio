# 怎么加一个外部执行器

节点默认由 `dsh` 执行（走节点会话）。`codex` / `custom` 是**外部执行器**：起一个外部进程，把最终文本与结构化判定按与 `dsh` 相同的口径收口。加第三种外部执行器时，改的是下面这条链，**不要**在引擎里写特例分支。

## 1. 先定契约

- **只允许 single**：外部执行器节点不能是 `mode='team'`（没有主管会话可挂）。校验在 `src/model.js`。
- **输入**：节点任务 / 角色 / 上游产物正文拼成的 prompt；一份 JSON Schema（节点 `outputs` 派生的结构化输出契约）。
- **输出**：最终文本 + 结构化判定（按同一份 `outputSchema` 解析出的结论）+ 过程事件 + 用量。
- **生命周期**：超时 / abort 必须整组杀掉（含 `sh -c` 派生的孙进程），不能只杀直接子进程。

验证：写进 [design/07 §6](../design/07-runtime-0.7.md) 与 [design/06 §17](../design/06-execution-engine.md) 的契约段，再动代码。

## 2. 在 `src/executor.js` 注册 kind

1. 把新 kind 加进 `EXECUTORS`（顺序即文档与检查器下拉框的展示顺序）。
2. 在 `normalizeExecutor(node)` 里归一化：节点配置 → `{kind, command, args, model}`；非法组合抛 `EXECUTOR_INVALID`（中文原因，上层按 `error.code` 分流）。
3. 默认值要有依据：`codex` 默认沙箱是 `workspace-write`，`custom` 必须填 `executorCommand`。

验证：`node test/executor.test.mjs` 里「三档归一化与 `EXECUTOR_INVALID`」组通过。

## 3. 拼 argv / 命令

- **argv 型**（像 codex）：写一个 `buildXxxArgs({cwd, schemaPath, model, prompt})`，只按该 CLI 真实支持的参数拼；结构化输出用 strict 形态（`additionalProperties: false`），否则服务端会 400。参考 `toStrictOutputSchema` / `buildCodexArgs`。
- **shell 型**（像 custom）：模板里的 `{prompt}` / `{schema}` / `{cwd}` 是占位符。**prompt 绝不拼进 shell 文本**：主通道是 0700 临时目录里的普通文件（0600）+ `FLOW_STUDIO_PROMPT_FILE` 环境变量，`{prompt}` 替换成 `"$(cat -- "$FLOW_STUDIO_PROMPT_FILE")"`；兼容通道是 `FLOW_STUDIO_PROMPT`（≤64KiB），兜底是 stdin。占位符位于单引号内是**不支持的位置**（shell 不展开，实际拿到的是替换产物字面量）。

验证：`node test/executor.test.mjs` 的「占位符与 shell 转义」「codex argv 顺序」「strict schema 转换」组通过；手工构造 `$(id -u)` / 反引号 / `$(rm -rf …)` 作为任务文本，确认按原文处理、不执行。

## 4. 消费进程输出

在 `runExternalExecutor({spec, prompt, cwd, timeoutMs, signal, spawn, onEvent})` 里：

- 逐行消费 stdout；JSONL 每行映射成事件（过程输出 → `agent/message`，最终文本、usage、未知事件各自收口）。
- 非 0 退出 / spawn 失败 / 超时 / abort 各自给 `reason` 与 `tail`（stderr 只留尾部 2000 字符）。
- 进程组：POSIX 下 `detached: true` + 整组 `SIGTERM`（250ms 宽限）→ `SIGKILL`；无法用进程组时退化并写 `killScope` / `orphanWarning`。
- 返回契约至少包含 `{ok, text, structured, exitCode, usage, events, reason?, tail?, message?, killScope, orphanWarning}`。

验证：`test/executor.test.mjs` 的「超时 / abort / 非 0 退出 / spawn 失败」「跨 chunk 半行」「真 node 子进程端到端」组通过；断言 abort 后孙进程不存活。

## 5. 接进引擎

`src/engine.js` 的 `_runExternalNode({runId, node, attempt, traceId, prompt, spec, signal, isTimedOut})` 已经处理：写 schema 文件、跑外部进程、把过程输出写成 `agent/message`（≤200 字符/条、最多 200 条）、累加用量并写 `model/call`、把最终文本与结构化判定回给主循环。

新 kind 若只换「怎么跑」，通常**不需要**改引擎；若引入新的事件形状或新的用量口径，先改 [design/05](../design/05-run-log.md) 与 `src/runlog.js`，再改引擎。外部执行器节点**不挂节点闹钟**（没有会话）。

验证：`node test/engine.test.mjs` 的 v0.7 组（custom 成功 / 非 0 退出 / stop / 缺命令 / 重试）通过；新 kind 补相应用例。

## 6. 校验与可见性

- `src/model.js`：
  - `executor` 白名单来自 `EXECUTORS`；未知值按普通字段进 `extras`，不抛错。
  - `custom` 缺 `executorCommand` → `validateFlow` 的 **error**（能存，不能开跑）。
  - 外部执行器 + `mode='team'` → error。
- `src/client/inspector.js`：检查器里的执行器下拉、外部执行器的可见标识（「这个节点由 X 在外部进程里跑」）、团队模式冲突提示。
- `src/client/model` 的 `executorCommandOf` 要兼容旧数据（值可能只存在 `extras` 里）。

验证：`node test/model.test.mjs` 的结构错误与坏数据收敛组通过；`node test/render.test.mjs` 确认检查器渲染出下拉与标识。

## 7. 文档与留痕

- 契约更新：[design/07 §6](../design/07-runtime-0.7.md)（运行模型）与 [design/06 §17](../design/06-execution-engine.md)（引擎侧）；事件形状改动同步 [design/05](../design/05-run-log.md)。
- 用户可见说明：[产品指南](../guide/overview.md) 的「节点可以换外部 executor」；环境开关（例如是否允许某个高权限 kind）进 [Host 接口](../reference/host-api.md)。
- 版本变化进 [docs/history/releases.md](../history/releases.md)。

## 8. 验收清单

```sh
node test/executor.test.mjs
node test/model.test.mjs
node test/engine.test.mjs
node test/render.test.mjs
node scripts/verify-build.mjs
```

- [ ] 非法配置能保存、不能开跑（error 在 `validateFlowForRun` 里）
- [ ] team + 外部执行器被拦
- [ ] prompt 不进 shell 文本（注入式文本按原文处理）
- [ ] abort / 超时后无孙进程残留，`killScope` / `orphanWarning` 如实
- [ ] 用量与事件按契约落盘，聚合口径不变
- [ ] 容器测试台通过（见 [容器测试台](run-container-testbed.md)）
