# dsh-flow-studio

> DeepSeek Harness 的**智能体工作流编排工作室**：在 Web 端用画布拖拽节点，把一条研发流水线画出来，
> 每个节点配成一个 agent 角色（单个 agent，或主管 + 若干子 agent），节点之间用「正常流转」和「打回」两种线连起来，
> 流程模板落到本机，随时打开继续改。

第一版（0.1.0）交付**设计器**：画布 + 节点配置 + 状态流转与打回循环 + 模板存储 + 结构校验。

**0.2.0** 是照设计终稿重写的设计器：208×96 节点卡（主从 208×116，成员行常驻）、打回线走下方**正交航道**
（每侧 6 个槽位，超过 6 条确定性降级成双线 + `+N` 角标）、选中用中性色 / 运行用 business 蓝、
全览单一世界坐标源（`fit = min((W−96)/boundsW, (H−96)/boundsH)`，地板 15%，装不下时提示「还有 N 列在视野外」）、
LOD 三档（60% / 45%）、键盘也能连线（`C` → `Tab` → `Enter`）、保存失败落**本地草稿**并能恢复。
设计依据在 [`docs/DESIGN.md`](docs/DESIGN.md)（四份分册 + [`docs/design/REVIEW.md`](docs/design/REVIEW.md) 的独立审核与逐条裁决）。

数据模型已经按「可执行」的形态设计：
未识别字段原样收进 `extras`（有界、坏输入不抛错），后续加字段不会被保存链静默丢掉。

**0.3.0 加上了运行日志的骨架**（[`docs/design/05-run-log.md`](docs/design/05-run-log.md)）：
每次运行落 `$DSH_HOME/flow-studio/runs/<runId>/`（append-only JSONL + 原子 `run.json`），
事件带 `runId / attemptId / nodeId / memberId / seq / traceId / ts`，底部抽屉能看 run 列表、事件流、详情与
token 四段合计，也支持导出 markdown。指标按契约确定性聚合：token 四桶、skill 覆盖率（唯一 skill 去重）、
findings 未解决/已复验、打回计数、阶段进度（打回后旧通过失效），以及**质量结论**——
后者要求验收条目、测试报告、规范检查、审查结论、P0/P1 五类证据齐全且可复核，缺证据一律「未检测」，不给绿灯。
**0.4.0 接上执行引擎**（[`docs/design/06-execution-engine.md`](docs/design/06-execution-engine.md)）：
点「运行」把图编译成执行计划，每个节点起一个真实的子 agent 会话（单个 agent，或主管 + 子 agent），
节点产物经结构化输出在节点之间传递，打回线按判定真的回退并累加 attempt。跑之前先把图校验一遍：
成环、断头路、多出边、打回指向结束节点、缺角色/缺任务一律 400 拒跑，不会跑到一半才卡死。
运行期间画布结构锁死、只读观察，可随时停止；单写者租约保证同一个 run 不会被两个进程同时写；
写盘失败会把 run 标成 `failed` 并留 `.error` 侧车，不静默挂住；预算按 run 限步数 / 墙钟 / 产物字节。
模型自述的证据（`provenance=model-claim`）必须对得上 `artifact/write` 的 path + sha256 且文件真实存在，
对不上就降级成「未检测」——**质量结论不接受自证**。

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
| 中间 | 画布：拖动节点、从右侧圆点拖到另一个节点建连线、双击空白处新增节点、裸滚轮缩放（指针锚定）、Shift+滚轮横移、中键/空格拖平移、`Alt` 拖动绕过 4px 吸附；双击空白以外的「全览」把整张图装进视口 |
| 右侧 | 检查器：选中节点或连线后配置；带「位置与连线」组——X/Y 坐标、四向 4px 微调（Shift 20px）、「连接到…」下拉 |
| 底栏 | 节点 / 连线 / 打回统计 + 结构校验结论（点开看逐条问题，可跳转到对应节点）+ 保存状态（含「本地草稿」） |

连线会自动判方向：**目标在下游就建「正常流转」，目标在上游就自动建成「打回」**，建完可以在检查器里改。

不用鼠标也能连：选中节点 → `C` 进入连线待定 → `Tab` / 方向键选目标（状态栏会念「从 X 到 Y」）→ `Enter` 建边 → `Esc` 取消。
单字母快捷键只在画布上下文（已选节点、焦点不在输入框）时生效。
保存失败或断连时改动落在 `localStorage` 的 `flow-studio:draft:<flowId>`，下次打开会问「恢复 / 丢弃」；
保存成功才显示「已保存」，草稿随之清掉。

## 安装

```sh
# 本地目录开发
dsh plugin --profile web add /home/feiyueve/文档/dsh/dsh-flow-studio
```

装完刷新页面，侧栏出现「流程编排」图标。Host 半边（路由）需要重启 `dsh web` 才挂载。

流程与 run 都落在 `$DSH_HOME/flow-studio/`（`flows/` 与 `runs/`，目录 0700、文件 0600）；没有另外的覆盖变量。

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
| GET | `/health` | 目录、schema 版本、skills 服务是否在位、`auth` 档位（`origin-only` / `token`） |
| GET/POST | `/runs` | run 列表（`limit`）/ 新建 run（`pending`，不自动开跑） |
| POST | `/runs/<runId>/start` | 真正开跑（`pending`→`running` 原子转换；已有 run 在写 → 409） |
| POST | `/runs/<runId>/stop` | 停止（协作式取消，写 `run/end aborted`） |
| GET/DELETE | `/runs/<runId>` | run 详情（节点与 attempt 索引 + `progress.nodes`）/ 删除整个 run（租约持有中 → 409） |
| GET/POST | `/runs/<runId>/events` | 事件流（`nodeId`、`attemptId`、`kind`、`since`、`order=desc`、`limit`）/ 追加事件（≤200 条/批，整批校验） |
| GET | `/runs/<runId>/summary` | 指标聚合（token / skill 覆盖率 / findings / 打回 / 进度 / 质量结论） |
| GET | `/runs/<runId>/export` | 导出 markdown |

**鉴权与 `/api` 同口径**：插件路由虽然绕过了 webserver 的 `/api` 通用鉴权（最长前缀优先），
但每个 handler 入口都会调宿主 `ctx.get('connection')?.requestRejection(req)`，把判定权交回宿主
（401/403 与 `/api` 一致；拿不到该服务时 **fail-closed 503**，绝不放行）。另有可选第二道闸
`FLOW_STUDIO_TOKEN`（≥16 字符，只认 `Authorization: Bearer`；`?token=` 仅导出接口允许）。
`/health` 在未鉴权时只说「认证档位」，不报内部路径。

## 开发

```sh
npm install
npm run build      # src/client/entry.js -> lib/client.js（esbuild，单文件 ≈143KB）+ 复制 Host 模块
npm test           # 九组自检，共 199 组
node test/render.test.mjs   # SSR + 构建产物加载，49 组
bash scripts/e2e-docker.sh  # 容器测试台端到端（真装真跑，桩引擎）
```

- `test/model.test.mjs` —— 出厂模板合法、坏数据收敛、四类结构错误能被抓出来、未知字段进 `extras` 不丢。
- `test/geometry.test.mjs` —— 世界边界唯一来源、fit 公式与 15% 地板、6 槽与第 7 条降级、tie-break 与输入顺序无关。
- `test/link.test.mjs` —— 键盘连线状态机：候选顺序、循环移动、Enter 确认、方向规则、可读播报。
- `test/draft.test.mjs` —— 草稿键名、写入读回、无 localStorage 时的内存退化、坏 JSON、内容指纹与恢复判定。
- `test/host.test.mjs` —— 存储增删改查 + 真实 HTTP 语义（伪造最小 ctx，把 `apply()` 注册的路由取出来直接喂 req/res）。
- `test/runlog.test.mjs` —— 事件校验与归一化（白名单、有界 `extra`、四桶用量、run/节点级字段规则、`callId` 必填）。
- `test/runstore.test.mjs` —— run 目录读写、分页过滤、删除、路径穿越拒绝、超限拒绝、坏 run 隔离、计数器。
- `test/metrics.test.mjs` —— 指标口径：token 四桶与重放替换、skill 唯一覆盖率、findings 三态、打回失效、质量判定表（含不明证据不给绿灯）。
- `test/engine.test.mjs` —— 执行引擎：结构不合格拒跑、单写者开始锁（并发 start 只成功一个）、打回按 attempt 重跑、
  预算中断、写盘失败终态、证据对账、桩模式双闸门。
- `test/render.test.mjs` —— 用真实 React 18 把每个组件 SSR 渲染一遍；再把构建产物 `lib/client.js` 放进只有
  `window.__ModuleLoader__` 的假环境里执行，验证注册 id、两个 slot 成对注册、面板能渲染出根节点；
  运行日志抽屉的收起/展开、空态、错误态、结论 pill 与键盘开合也在这里断言。

> SSR 只跑首次渲染，不跑 `useEffect`，也不测拖拽 / 缩放这些交互。**这不等于浏览器验证。**

## 路线图

- **v0.5 指标看板增强**：跨 run 对比、趋势图、团队汇总；把 `acceptance` / `test` / `check` 三类证据接上独立执行器
  （引擎已经会写这三类事件，但报告内容目前取决于节点自己的结构化输出，还没有外部的检查器去跑）。
- **v0.6 图中图**：一个节点内部再展开成子图（主管带子 agent 的可视化展开）。
- **v0.7 多人协作**：run 的单写者租约已经按「多浏览器同时看是安全的」设计；多人同时**编辑**同一份流程还没做。

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
