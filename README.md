# dsh-flow-studio

> DeepSeek Harness 的**智能体工作流编排工作室**：在 Web 端用画布拖拽节点，把一条研发流水线画出来，
> 每个节点配成一个 agent 角色（单个 agent，或主管 + 若干子 agent），节点之间用「正常流转」和「打回」两种线连起来，
> 流程模板落到本机，随时打开继续改。

第一版（0.1.0）交付**设计器**：画布 + 节点配置 + 状态流转与打回循环 + 模板存储 + 结构校验。
执行引擎与指标看板在路线图里（见文末），数据模型已经按「可执行」的形态设计。

## 它解决什么

把一句「帮我做个 X」变成一条能盯住的流水线：

```
任务输入 → 需求分析 → 方案设计 → 结构设计 → 开发 → 测试 → 代码审查 → 完成
                ↑           │            │              │        │
                └──方案打回──┘            │              │        │
                            └──结构打回───┘              │        │
                                          └──测试打回────┘        │
                                                    └──审查打回───┘
```

- **每个节点就是一个 agent**：写清「它是什么人」（角色定位）和「它负责什么」（任务），
  选「单个 agent」还是「主管 + 子 agent」，主从模式下再逐个配子 agent 的分工。
- **节点可以挂 skill**：从当前 profile 已注册的 skill 里勾选（例如「怎么开发 Java 服务」这类开发规范），
  运行时要求子 agent 先加载再干活。
- **打回是图的一部分，不是例外**：一条打回线指向任意上游节点，自动构成循环；每个节点可单独设打回上限。
- **模板存在本机**：`$DSH_HOME/flow-studio/flows/<id>.json`，换浏览器、换设备都还在。

## 界面

| 区域 | 做什么 |
|---|---|
| 左侧 | 流程模板列表：新建 / 打开 / 删除 |
| 中间 | 画布：拖动节点、从右侧圆点拖到另一个节点建连线、双击空白处新增节点、滚轮缩放、拖空白处平移 |
| 右侧 | 检查器：选中节点或连线后配置 |
| 底栏 | 节点 / 连线 / 打回统计 + 结构校验结论（点开看逐条问题，可跳转到对应节点） |

连线会自动判方向：**目标在下游就建「正常流转」，目标在上游就自动建成「打回」**，建完可以在检查器里改。

## 安装

```sh
# 本地目录开发
dsh plugin --profile web add /home/feiyueve/文档/dsh/dsh-flow-studio
```

装完刷新页面，侧栏出现「流程编排」图标。Host 半边（路由）需要重启 `dsh web` 才挂载。

数据目录可用 `FLOW_STUDIO_HOME` 覆盖（默认跟随 `$DSH_HOME`）。

## 数据模型

一份流程就是一个 JSON：

```jsonc
{
  "schemaVersion": 1,
  "id": "flow-ab12cd34ef",
  "name": "标准研发流水线",
  "nodes": [
    {
      "id": "n_req", "kind": "stage",        // start | stage | end
      "title": "需求分析", "x": 300, "y": 220,
      "mode": "single",                      // single | team
      "role": "资深需求分析师……",             // 角色定位
      "task": "把任务卡拆成可验收的需求条目……",  // 负责的事
      "skills": ["java-service"],            // 引用的 skill 名
      "outputs": "需求清单 R1..Rn + 风险表",   // 期望产物
      "maxRounds": 2,                        // 打回上限
      "model": "",                           // 模型覆盖，空 = 跟随会话
      "team": [{ "name": "接口实现", "role": "……", "task": "……" }]
    }
  ],
  "edges": [
    { "id": "e_1", "from": "n_req", "to": "n_plan", "kind": "next", "label": "" },
    { "id": "e_2", "from": "n_plan", "to": "n_req", "kind": "reject", "label": "方案被打回" }
  ]
}
```

校验分两级：**error**（跑不起来：没有开始节点、有孤立节点、打回目标不在上游、阶段节点没写任务…）
与 **warning**（能存但作者大概还想改：没写角色、主从节点没配子 agent、走不到结束节点…）。

## Host 接口

单条 `prefix` 路由 `/api/flow-studio`，同源 fetch 调用：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/flows` | 流程摘要列表（目录为空时自动种一份出厂模板） |
| POST | `/flows` | 新建 |
| GET | `/flows/<id>` | 读整份 + 校验结果 |
| PUT | `/flows/<id>` | 整份覆盖保存 |
| DELETE | `/flows/<id>` | 删除 |
| GET | `/skills` | 当前 profile 已注册的 skill 目录（`ctx.skills.list()`） |
| GET | `/health` | 目录、schema 版本、skills 服务是否在位 |

插件路由不会被 webserver 的 `/api` 通用鉴权拦到（最长前缀优先，exact/prefix 会先命中插件自己），
所以这里自己挡跨站请求：带了 `Origin` 且与 `Host` 不一致一律 403。

## 开发

```sh
npm install
npm run build      # src/client/entry.js -> lib/client.js（esbuild，单文件 46KB）+ 复制 Host 模块
npm test           # 三组自检，共 36 个断言
```

- `test/model.test.mjs` —— 出厂模板合法、坏数据收敛、四类结构错误能被抓出来。
- `test/host.test.mjs` —— 存储增删改查 + 真实 HTTP 语义（伪造最小 ctx，把 `apply()` 注册的路由取出来直接喂 req/res）。
- `test/render.test.mjs` —— 用真实 React 18 把每个组件 SSR 渲染一遍；再把构建产物 `lib/client.js` 放进只有
  `window.__ModuleLoader__` 的假环境里执行，验证注册 id、两个 slot 成对注册、面板能渲染出根节点。

> SSR 只跑首次渲染，不跑 `useEffect`，也不测拖拽 / 缩放这些交互。**这不等于浏览器验证。**

## 路线图

- **v0.2 执行引擎**：把图编译成执行计划，每个节点起一个真实的子 agent 会话
  （`ctx.subagents.startActivation({ provider: 'spawn', delivery: 'caller', request: { prompt, parent, outputSchema } })`），
  节点产物用结构化 JSON 在节点之间传递，打回线按判定结果真的回退并累加轮次。
- **v0.3 指标**：以 `session/event`（global）为主干，按节点归集 token（`assistant/message.usage` 五桶）、
  工具调用、skill 采纳（`tool/call` 里 `name === 'skill'`）、审查 finding 数与采纳率。
- **v0.4 图中图**：一个节点内部再展开成子图（主管带子 agent 的可视化展开）。

## 先搜现成的（按 `PLUGIN-SEARCH.md`）

新建插件前先搜过一轮，留痕如下（2026-11-06）：

- **形态关键词**：`dsh workflow / canvas / graph / orchestration` + `reactflow` / `react-flow`，
  GitHub 仓库搜索命中 587 / 203 / 271 / 199 条；代码搜索 `"dsh.bundle" filename:package.json + canvas` 命中 2 条、
  `"reactflow" filename:package.json dsh` 命中 50 条；npm `dsh workflow|graph|orchestration` 逐条看过包名。
- **最接近的候选**：
  - `GZX2211/dsh-Visual-Workflow`（★64，MIT，v0.10.3）——画布 + 节点级角色 + 主从多 agent 三件齐备，
    缺打回状态机与指标看板；仓库 40.8MB / 1536 文件，依赖 `@huggingface/transformers` → onnxruntime-node / sharp，
    `peerDependencies` 全是 `*`。
  - `chumingjun/dsh-harness-one`（★31）——React Flow 画布 + 8 类节点，但无主从编排、不声明 peer/engines。
  - `CodermanYHZ/dsh-node-flow`（★15）——最小画布骨架（`@xyflow/react` + zustand），2026-08 后停更。
  - `toolclub/dsh-agent-team-gui`（★288）——主从 + Run Center 指标最好，但无画布、peer 钉在 0.1.5 旧世代。
  - `miuzel/dsh-graph`（★25）——状态机 + 泳道看板那一半的现成范本，不是编排画布。
- **结论：自研**。理由：没有一个候选同时覆盖「画布 + 节点角色 + 主从 + 打回状态机 + 指标」；
  最接近的 Visual-Workflow 体量大、带原生编译依赖、且它的「回流重试」是节点级重试而不是显式的打回连边，
  要在 1536 个文件里再加两层（打回状态机 + 指标看板），代价高于按本仓的零依赖实现重写。
  **本仓从候选里借的是思路**：画布与检查器分离、节点级角色/模型覆盖、按 upstream 判打回方向。
  内置 `workflow` 工具（脚本编排 subagent）与 `dsh-advisor-flow`（会话级顾问）都不覆盖可视化与状态机。

## License

MIT
