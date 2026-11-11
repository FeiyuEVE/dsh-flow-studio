# 11 · 节点完成工具与产物约定（0.13.1 硬契约）

> 用户 2026-11-11 定调：**agent 节点必须调用约定工具才算结束**；通过这个工具给实例注入后续网关要用的变量；**节点产出的文档落文件，不要用大 JSON 或长文本字段变量**。本文把这个约定写成可实现的契约，`09-agent-adapter-hooks.md` 的 `AgentAdapter` 与它配合。

## 1 硬约定

1. **agent 节点要完结自己、让流程往后流转，只能通过调用工具 `flow_finish_node`。** 自然语言收尾、进程退出、token 用尽都不算完结——节点会一直等（直到活动超时/取消）。
2. 这个约定**与 `endEvent` 无关**：`endEvent` 是 BPMN 的结束事件，照旧由引擎处理，不要求调用任何工具。
3. 一次活动执行只接受**一次**成功调用；重复调用返回 `NODE_ALREADY_FINISHED`（幂等：同参数重放也返回该错误，不重复写产物）。
4. 会话/进程结束但没调用过 → 节点失败 `NODE_FINISH_MISSING`，事件流里带 `error{code:'NODE_FINISH_MISSING'}`；**禁止**把「模型说了完成」当成完成。
5. 工具调用是**流转的触发器**：`executeAgent` 拿到工具参数后返回，runner 才把该活动标记完成并评估出向连线（网关条件读的就是这次注入的变量）。
6. adapter 若无法向该 agent 暴露工具（能力表 `capabilities.finishTool` ≠ `native`），**在 admission 阶段拒绝**该节点，不允许静默降级成「看输出文本猜结论」。

## 2 工具入参

```jsonc
{
  "variables": { "verdict": "pass", "reason_code": "OK", "score": 87, "needs_review": false },
  "documents": [
    { "path": "docs/plan/0.13-方案.md", "kind": "markdown", "title": "方案", "summary": "≤200 字说明这份文档是什么" }
  ],
  "summary": "这次节点做了什么、结论是什么（≤500 字）"
}
```

- **`variables` 是后续网关条件唯一的数据来源**（FEEL 直接读实例变量）。硬限制：键 ≤32 个；值只允许 `boolean | number | string(≤512 字符) | null`；序列化后 ≤8 KiB。超限 → `NODE_VARIABLES_INVALID`，整次调用失败，节点不结束。
- **禁止**在 `variables` 里放大对象、数组、base64、文档正文、长 JSON。需要给下游看的内容一律落文件，用 `documents` 引用。
- `documents` 最多 32 份；`path` 必须是**工作区内的相对路径**（禁止绝对路径、`..` 段、反斜杠、空段，≤1024 字符——沿用 `src/runlog.js` 的 artifact 路径规则）；`kind` ≤64、`title` ≤200、`summary` ≤200。宿主用**同一文件句柄**有界读取校验：普通文件、`realpath` 落在工作区内（防符号链接逃逸）、≤5 MiB、读到字节数与 stat 一致（校验中被改则拒），计算 `sha256` 与 `bytes`。
- `documents[].summary` 只是给人看的一句话，不承载正文。

## 3 产物怎么落

沿用平台既有约定（`src/runlog.js` 的 `artifact/write`：相对路径 + `sha256`），实例域落盘形态：

```
$DSH_HOME/flow-studio/instances/<id>/
  instance.json          # artifacts[] 索引：{ path, sha256, bytes, kind, title, nodeId, attempt, at }
  events/<shard>/<n>.jsonl
  state.json
```

- 文档正文由 agent 自己写进工作区文件（这是它本来就要做的事），宿主只登记引用。
- `instance.json.artifacts[]` 由运行时维护；`activity/end` 事件的 `artifacts[]` 只带引用（path/hash/bytes/kind/title），事件里**不出现**文档正文。
- 产物校验失败（路径越界、不存在、符号链接逃逸、超 5 MiB、校验中被改）→ `NODE_DOCUMENT_INVALID`，节点不结束；错误信息带 `path` 与原因，不打印文件内容。

## 4 各 adapter 怎么提供工具

| adapter | 工具通道 | 校验「必须调用」的方式 | 能力标记 |
|---|---|---|---|
| `dsh` | 子 agent 会话注册模型工具 `flow_finish_node`（宿主 `ctx` 工具注册，会话级可见） | 工具 handler 记一次完成；会话结束仍未调用 → `NODE_FINISH_MISSING` | `finishTool: native` |
| `codex` | 插件自带 MCP stdio server 暴露同名工具，`codex exec` 配置 `mcp_servers` 指向它 | MCP 调用记完成；进程退出仍未调用 → `NODE_FINISH_MISSING` | `finishTool: native`（依赖 MCP 能力，probe 时必须实测） |
| 其它/旧版 | 无 | admission 拒绝 | `finishTool: unsupported` |

工具调用与活动生命周期的关系：`executeAgent` **不返回**直到工具被调用（或失败/超时/取消）。因此 runner 的活动超时照常生效，超时 → `BPMN_ACTIVITY_TIMEOUT`，同时 abort 会话。

## 5 与 runner / 运行时接口的关系

- runner 侧不需要知道工具：`executeAgent(element, ctx)` 的返回值携带 `{ output, usage, artifacts, events }`（现有契约已支持 `artifacts`），其中 `output` **只含短变量**，`artifacts` 只含引用。
- 运行时把它们合并：`variables` 只合并 `output`（短标量），`artifacts` 写进 `instance.json.artifacts[]`；`instance.result` 在 `process/end` 时取最后一次 agent 节点的 `output`（`endEvent` 不产生输出）。
- 网关条件只读 `variables`，因此条件里永远不可能出现文档正文——这也是「大 JSON 不进变量」这条约定在引擎侧的自然结果。

## 6 与会话提示词的配合

adapter 必须把「怎么完结当前节点」写进节点提示词（不是可选项）：

```
做完本节点的活、要往下流转时，必须调用工具 flow_finish_node：
  variables  后续网关要用的短变量（标量）
  documents  你写下的文件的相对路径清单（正文在文件里，不要塞进 variables）
  summary    一句话说明本节点做了什么
不调用该工具就不算完结，流程不会往下走。
```

## 7 验收（0.13.1 必须有的）

1. 正常：agent 调工具 → 节点完结、`activity/end` 带 `output` 与 `artifacts`，实例变量里能看到注入的 `verdict`，网关按它路由到正确的下一条连线；
2. 不调工具：会话正常结束 → 实例 `failed` + `NODE_FINISH_MISSING`（不是 done）；
3. 变量超限：塞 9 KiB 或嵌套对象 → `NODE_VARIABLES_INVALID`，节点不结束；
4. 文档不存在 / 路径越界 / 超 5 MiB → `NODE_DOCUMENT_INVALID`；
5. 重复调用 → `NODE_ALREADY_FINISHED`，产物索引不重复；
6. 超时中断：工具从未调用且活动超时 → `BPMN_ACTIVITY_TIMEOUT` 且会话被 abort（不是挂住）。
