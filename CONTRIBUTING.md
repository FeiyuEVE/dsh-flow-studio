# 参与贡献

本仓库是 DeepSeek Harness 的插件，Node ≥ 20，无运行时依赖（XState v5 已 vendored 进仓）。改代码前先读 [docs/AGENTS.md](docs/AGENTS.md)（文档落在哪一层）与相关设计分册。

## 本机准备

```sh
git clone git@github.com:FeiyuEVE/dsh-flow-studio.git
cd dsh-flow-studio
npm install
```

`npm install` 只装 devDependencies（`@xyflow/react`、esbuild、react、react-dom）；构建产物 `lib/` 被 `.gitignore` 排除，必须自己 build。

## 构建与发布前校验

```sh
npm run build                    # src/client/entry.js → lib/client.js（esbuild 单文件，≈440 KB，含 React Flow 12）+ 复制 Host 模块
node scripts/verify-build.mjs    # 只读校验：lib/ 的 .js 集合与清单一致、src↔lib 逐字节相同、main 入口存在
node test/render.test.mjs        # SSR + 构建产物加载，99 组
bash scripts/e2e-docker.sh       # 容器测试台端到端（真装真跑，桩引擎）
```

`build.mjs` 末尾自带门禁：清单非空、`lib/` 的 `.js` 集合与清单完全一致、每个 Host 模块与 `src/` 逐字节相同；任何一项不符都非零退出。`prepack` / `pretest` 会强制先 build，所以「发了缺产物的包」或「带了陈旧 lib」会被直接挡下。

## 测试

```sh
npm test
```

**23 个自检文件**：`test/build.test.mjs`（发布门禁 8 组 / 56 条断言）+ 22 个功能套件共 **847 组**（其中 9 个套件显式计数，合计 3986 条断言）。测试不联网、不依赖真 codex：外部 executor 用注入的假 `spawn`，容器测试台用桩引擎。

### 测试套件地图

- `test/model.test.mjs` —— 出厂模板合法（六个阶段默认「主管 + 3 个子 agent」，往返保存不丢成员）、坏数据收敛、四类结构错误能被抓出来、未知字段进 `extras` 不丢。
- `test/geometry.test.mjs` —— 世界边界唯一来源、fit 公式与 15% 地板、6 槽与第 7 条降级、tie-break 与输入顺序无关。
- `test/link.test.mjs` —— 键盘连线状态机：候选顺序、循环移动、Enter 确认、方向规则、可读播报。
- `test/draft.test.mjs` —— 草稿键名、写入读回、无 localStorage 时的内存退化、坏 JSON、内容指纹与恢复判定。
- `test/host.test.mjs` —— 存储增删改查 + 真实 HTTP 语义（伪造最小 ctx，把 `apply()` 注册的路由取出来直接喂 req/res）；v0.7 组覆盖保存宽松（空流程 / executor 非法也 200 + validation）、`?workspaceId=` 过滤、`POST /runs/<id>/supervision` 的 400/404/enable/disable 与已收尾 run 拒绝开启；v0.8 组覆盖 `GET /runs` 列表行 / 详情 / summary 三处 `nodeStatus`（缺省 `{}`）。
- `test/runlog.test.mjs` —— 事件校验与归一化（白名单、有界 `extra`、四桶用量、run/节点级字段规则、`callId` 必填）；v0.8 组覆盖 `node/status` 通过校验、可选字段收敛、成员 / 阻塞项有界与坏输入拒绝。
- `test/runstore.test.mjs` —— run 目录读写、分页过滤、删除、路径穿越拒绝、超限拒绝、坏 run 隔离、计数器（含「刚写的 `*.tmp-*` 不能被启动清理删掉」与「临时文件被外部删掉时原子写重试」两条回归）；D 组覆盖 `nodeStatus` 的 256 KiB 字节预算与裁剪顺序、`nodeStatusTruncated`、损坏 `run.json` 备份且拒绝覆盖、并发 append 的 seq 单调、`startOptions` 白名单。
- `test/metrics.test.mjs` —— 指标口径：token 四桶与重放替换、skill 唯一覆盖率、findings 三态、打回失效、质量判定表（含不明证据不给绿灯）。
- `test/flowmachine.test.mjs` —— 状态机编译纯函数：版本哈希只含影响转移的字段、状态/边集与 flow 一致、pass 链 / 显式与兜底打回 / 打回上限 / 未知 verdict / 超时与取消、持久化往返、事件流重放等价、非法 flow 矩阵（12 组 / 251 断言）。
- `test/engine-machine.test.mjs` —— 引擎 × 状态机：同一组行为用例分别跑 actor 驱动与 `FLOW_STUDIO_FLOW_MACHINE=0` 旧循环；机器专属覆盖 `run.json.machine` 落盘、`machine/transition`、快照恢复 / 版本不匹配重放 / 恢复失败收口（25 组 / 136 断言）。
- `test/engine-restart.test.mjs` —— v0.9.2 前置：`flow_node_reject` 按「阶段节点 + 有出向 reject 边」门控（无边不注册）、工具打回真的走 `reject/trigger` 与目标 attempt+1、失败后 `restart` 建新 run 并继承旧会话 / 跳过已完成节点 / 按当前结构重挂工具 / 旧 run 终态不改写 / 错误可诊断。
- `test/engine.test.mjs` —— 执行引擎：结构不合格拒跑（含 reject 边两端必须是阶段节点的启动校验）、单写者租约与同 runId 二次 start 409、打回按 attempt 重跑、预算中断、写盘失败终态、证据对账、上游产物正文进提示词、证据引用透传与回退、节点失败重试与失败隔离、桩模式双闸门；v0.7 组另覆盖工作区 / worktree、sessionMode 降级可见、外部 executor（custom 成功 / 非 0 退出 / stop / 缺命令 / 重试）；v0.8 组覆盖节点闹钟：建会话即登记、attempt 结束注销先于 run 收尾、打回重跑重新登记、`node/status` 三处可见、`done+verdict` 提前完成（`completedBy:'self-check'`）、非法 verdict 不提前完成、未注入调度器时退回 v0.7、外部 executor 不登记。
- `test/worktree.test.mjs` —— 工作区与 worktree：`workspaceIdFor` 稳定、真 git 仓库根 / 子目录 / 非 git 的区分、`git` 不可用与「不是仓库」分开、`auto/on/off` 决策、分支冲突 `-2`、真 worktree 落盘、脏 worktree 删除校验与路径越界拒绝。
- `test/executor.test.mjs` —— 外部 executor：三档归一化与 `EXECUTOR_INVALID`、codex argv 顺序、strict schema 转换、JSONL 的 final / usage / 过程 / 未知事件、custom 占位符与 shell 转义、超时 / abort / 非 0 退出 / spawn 失败、跨 chunk 半行、真 node 子进程端到端；**不依赖真 codex、不联网**。
- `test/runtime.test.mjs` —— 进程级注册表：两个 runId 并发跑通、同 runId 二次 start 409、失败实例摘除、sessionIndex 跨实例共享、`sweep` 崩溃残留、`createEngine/new Engine` 旧用法兼容、supervision 接线与收尾落盘；v0.8 组覆盖 `wake` 的 idle→followup / busy→inject / 拿不到→skip、提示词、收尾 `unregisterRun` 与 `dispose` 停表。
- `test/supervise.test.mjs` —— 内建 supervision：`planWake` 五档间隔、到点只唤醒一次、失败 3 次降级 / 成功清零 / 重启恢复 / 终态摘除 / 坏日期不抛错 / tick 重入保护；v0.8 节点闹钟组覆盖 `parseNodeStatus` 的围栏 / 裸 JSON / 默认值 / 大小写 / 取整 / 上限，`NodeSupervisionScheduler` 的 600s 默认间隔（`FLOW_STUDIO_NODE_ALARM_MS` 可覆盖）、`skip` 推进但不计 `wakes`、连续 3 次失败停摆、刷新与三种注销。
- `test/client-perf.test.mjs` —— 客户端性能回归：拖动中 0 次提交 / 松手恰好 1 次、锁定不提交、节点与边是 `React.memo` 且相同输入复用同一对象、草稿去抖（5 次变更只写 1 次、maxWait 必落、隐藏立即 flush）。
- `test/logdrawer.test.mjs` —— 运行详情：抽屉三档与全屏类、Esc 逐档还原、节点面板四类实时字段、缺失字段降级占位、长文本展开全文弹层、区域开关与窄屏单列、新 CSS 只用主题 token。
- `test/audit.test.mjs` —— 工作流健康审计（纯函数）：pending / healthy / stalled / looping / deviating / no-progress / done / failed / aborted 九种裁决，以及打回后重跑不误判偏航、坏输入不抛错。
- `test/tools.test.mjs` —— 会话内启停的五个基础模型工具：按 id/名字启动、同名多份列候选、结构不合法不建 run、`options.parent === exec.agent`（绑定发起会话与工作区）、flow_start 自动开启 supervision / 失败回退、flow_supervise 开关、flow_watch 走真实审计、flow_stop 业务态、输出 lossless、无 tools 服务时不炸；v0.8 组覆盖 `flow_watch.nodeStatus` 与 `blocked` + 连续两次进度不变的 `recommended` 提示。
- `test/inbox.test.mjs` —— 流程收件箱与节点会话复用：`message/in`/`message/out` 事件与有界截断、messages.jsonl 追加与分页、目标节点三路解析、活/冷会话注入、未开始当启动输入、排队与推进时并进提示词、下游可见且有界、`flow_reply` 三种回复通道、`flow_send_message` 省略 runId、HTTP 401/400/200、二次激活只起一次会话、sessions.json 容错、run 收尾 dispose、无 agents 服务退化。
- `test/render.test.mjs` —— 用真实 React 18 把每个组件 SSR 渲染一遍；再把构建产物 `lib/client.js` 放进只有 `window.__ModuleLoader__` 的假环境里执行，验证注册 id、两个 slot 成对注册、面板能渲染出根节点；运行日志抽屉的收起/展开、空态、错误态、结论 pill 与键盘开合也在这里断言；v0.8 组覆盖运行详情「节点状态」区块（标题 / 状态徽标 / 进度条 / verdict / members / blockers / 坏数据降级 / 超过 6 个节点内部滚动）。

> SSR 只跑首次渲染，不跑 `useEffect`，也不测拖拽 / 缩放这些交互。**这不等于浏览器验证。**

## 测试纪律

### 不要对 XState 内部对象做断言

0.9.0 发布前一条测试写法把宿主打成 22 GB OOM：对 **XState 内部对象**（`StateNode`、`transition`、`snapshot`、`machine.states.*`）做 `assert.equal` / `assert.deepEqual`。断言失败时 Node 会 `inspect` 整个机器引用图——**单次失败实测分配约 4 GB**（rss 51 MB → 4126 MB），进程 45 秒涨到 22 GB，打爆宿主 dsh-web 的 24 GB cgroup，服务被重启。完整时间线、根因链与遗留项见 [事故记录](docs/postmortem/2026-11-07-oom.md)。

- **只对纯数据断言**：`machine.config.initial`、`Object.keys(machine.states)`、`transition.target.map(n => n.id)`、JSON 往返后的快照（`JSON.parse(JSON.stringify(snapshot))`）。
- 需要看结构时先降维成普通对象，永远不要把 `StateNode` / actor 本体交给断言库。
- `test/flowmachine.test.mjs` 里的 `guardUnsafeAssert` 会识别 `StateNode` / `StateMachine` / `TransitionDefinition` 并在进 diff 之前抛清晰错误；新写状态机测试复用它。
- 跑测试一律带时间与内存上限：`timeout 300 node --max-old-space-size=2048 test/xxx.test.mjs`；需要更硬的兜底时加 `ulimit -v`。**heap cap 管不住外部内存**，所以时间上限与 `ulimit` 同样重要。

### 其他纪律

- 新行为先写能失败的断言，再改实现；修 bug 的提交带回归。
- 不在测试里连网、不依赖真 `codex`；进程行为用注入的 `spawn` / 假时钟。
- 改事件契约先改 [design/05](docs/design/05-run-log.md)，再改 `src/runlog.js` 的白名单、校验、聚合与客户端。
- 改前端 CSS 只用宿主 token（`--dsw-*`），不硬编码颜色与字号；12px 是正文地板。

## 提交规范

Conventional Commits 风格，一条提交只做一件事：

```
feat(0.9.0): 状态机内核——转移决策交给 XState v5 actor
fix(runstore): 过期租约/陈旧锁接管改为选举
docs(readme): 0.4.1 租约互斥说明与 203 组测试
test(e2e): 列表端点也断言 progress.nodes
chore(release): 0.4.1
```

- 提交信息写清「改了什么 + 为什么」，不写「update files」。
- 文档改动与代码改动分开提交；文档提交不顺手改 `src/`、`test/`、`scripts/`、`package.json`、`LICENSE`、`THIRD-PARTY.md`、`cordis.patch.yml`、`locale/`。
- 不在提交里带 `lib/`（构建产物被 `.gitignore` 排除）、`node_modules/`、`.tmp/`、`.tmp-*`。
- 改文档后按 [docs/AGENTS.md](docs/AGENTS.md) 检查「事实是否只有一个家」，并确认相对链接可打开。

## 发版流程

摘要（完整步骤与验证结果见 [发版手册](docs/cookbook/release.md)）：

1. 确认 `package.json` 版本与 `docs/history/releases.md` 对应段落一致；顺带同步 README / CONTRIBUTING 里的易腐数字（测试组数、`lib/client.js` 体积）。
2. `npm run build` → `node scripts/verify-build.mjs` → `npm test`（带时间上限）。
3. `npm pack` 检查包内容（`lib`、`THIRD-PARTY.md`、`cordis.patch.yml`、`locale/*.json`、`icon.svg`）。
4. `npm publish` 到 `@feiyueve` 私源（scope 已在 `~/.npmrc` 指向私源）。
5. **从私源装回去对账**：在容器测试台里 `dsh plugin add` 私源版本、跑 `scripts/e2e-docker.sh`、核对版本与 `/health`；装完与私源产物逐文件对账。
6. 登记：父仓库 `PLUGINS.md` 的插件行与兼容矩阵。

发版前最好在容器测试台里先验收一遍：[容器测试台](docs/cookbook/run-container-testbed.md)。**不要用宿主 `~/.dsh` 的 web / staging profile 试错。**
