# 参与贡献

本仓库是 DeepSeek Harness 的插件，Node ≥ 20。改代码前先读 [docs/AGENTS.md](docs/AGENTS.md)（文档落在哪一层）与相关设计分册（当前契约以 `docs/design/10–13` 为准）。

## 本机准备

```sh
git clone git@github.com:FeiyuEVE/dsh-flow-studio.git
cd dsh-flow-studio
npm install
```

`npm install` 只装 devDependencies（esbuild、react / react-dom、bpmn-js 与属性面板、playwright-core）；构建产物 `lib/` 被 `.gitignore` 排除，必须自己 build。工作树里的 `node_modules` 若是指向主仓的符号链接，不要在 worktree 里跑 `npm install` 覆盖它。

## 构建与发布前校验

```sh
npm run build                    # client.js（主包）+ client.bpmn.js（BPMN 画布 chunk）+ 复制 Host 模块
node scripts/verify-build.mjs    # 只读校验：lib/ 的 .js 集合与清单一致、src↔lib 逐字节相同、独立重建一致
node test/render.test.mjs        # SSR + 构建产物加载
bash scripts/e2e-bpmn.sh         # 容器测试台端到端（真装真跑，只走 HTTP 跑定义 / 实例 / 人工任务）
```

`build.mjs` 末尾自带门禁：清单非空、`lib/` 的 `.js` 集合与清单完全一致、每个 Host 模块与 `src/` 逐字节相同、主包不含 BPMN 重依赖、chunk 与主包都不含旧 React Flow；任何一项不符都非零退出。`prepack` / `pretest` 会强制先 build，所以「发了缺产物的包」或「带了陈旧 lib」会被直接挡下。

## 测试

```sh
npm test
```

测试不联网、不依赖真 codex：agent 适配器用注入的假实现，容器测试台用桩适配器。

### 测试套件地图（按域）

- **构建与发布门禁**：`test/build.test.mjs`（干净检出 → 构建 → npm pack → tarball 逐项断言、verify-build 反例、factory 隔离）、`test/chunk-protocol.test.mjs`、`test/e2e-mount-isolation.test.mjs`。
- **Host / 鉴权 / 退役边界**：`test/host-auth.test.mjs`（connection fail-closed、两档令牌、只读令牌、路径防线、旧 `/flows` `/runs` `/worktrees` 认证后 404、工具集合恰好 11 个）。
- **BPMN 解析与执行**：`test/bpmn-parse.test.mjs`、`bpmn-moddle.test.mjs`、`bpmn-expr.test.mjs`、`bpmn-runner.test.mjs`、`bpmn-runtime.test.mjs`。
- **存储与资源**：`test/definition-store.test.mjs`、`instance-store.test.mjs`、`instance-resources.test.mjs`、`instance-message-store.test.mjs`、`instance-inbox.test.mjs`、`instance-inbox-spill.test.mjs`、`artifact-store.test.mjs`、`execution-limits.test.mjs`、`connector-store.test.mjs`、`instance-worktree.test.mjs`、`workspace-policy.test.mjs`。
- **agent 适配器与完结门**：`test/agent-adapter-dsh.test.mjs`、`agent-adapter-codex.test.mjs`、`agent-execute.test.mjs`、`agent-telemetry.test.mjs`、`node-finish.test.mjs`、`node-finish-mcp.test.mjs`。
- **指标 / 证据 / 收件箱**：`test/instance-metrics.test.mjs`、`instance-evidence.test.mjs`、`instance-tools.test.mjs`、`instance-tools-model.test.mjs`。
- **客户端**：`test/client-definition.test.mjs`、`client-instance.test.mjs`、`client-worktree.test.mjs`、`client-inbox.test.mjs`、`client-metrics.test.mjs`、`client-evidence.test.mjs`、`client-page-wiring.test.mjs`（含「页面网络不再请求 `/flows` `/runs`」的 fetch spy）、`client-perf.test.mjs`、`draft.test.mjs`、`logdrawer.test.mjs`、`render.test.mjs`。
- **其它**：`test/http-policy.test.mjs`、`http-connector.test.mjs`、`host-check.test.mjs`、`process-output.test.mjs`（限额 / 脱敏的纯单元）。

浏览器用例单独跑（需要 Chromium）：

```sh
BPMN_TEST_BROWSER=/usr/bin/google-chrome node test/client-bpmn.browser.test.mjs
BPMN_TEST_BROWSER=/usr/bin/google-chrome node test/client-worktree.browser.test.mjs
```

## 测试纪律

- **只对纯数据断言**：不要把库内部对象（例如 bpmn-engine 的 `Definition` / `Engine` 实例）直接交给 `assert.deepEqual`；断言失败时 Node 会 inspect 整个引用图，可能把进程内存打爆。先降维成普通对象。
- 跑测试带时间与内存上限：`timeout 300 node --max-old-space-size=2048 test/xxx.test.mjs`。
- 新行为先写能失败的断言，再改实现；修 bug 的提交带回归。
- 不在测试里连网、不依赖真 `codex`；进程行为用注入的 `spawn` / 假时钟。
- 改实例事件契约先改 [design/10](docs/design/10-bpmn-instance-api.md)；改指标先改 [design/12](docs/design/12-instance-metrics.md)；改证据先改 [design/13](docs/design/13-instance-evidence.md)。
- 改前端 CSS 只用宿主 token（`--dsw-*`），不硬编码颜色与字号；12px 是正文地板。
- 临时文件一律放仓库 `.tmp/`（已被 `.gitignore` 排除），不要写 `/tmp`。

## 提交规范

Conventional Commits 风格，一条提交只做一件事：

```
feat(instance): …
fix(bpmn-runner): …
docs(host-api): …
test(host-auth): …
chore(release): 0.14.0
```

- 提交信息写清「改了什么 + 为什么」，不写「update files」。
- 文档改动与代码改动分开提交；文档提交不顺手改 `src/`、`test/`、`scripts/`、`package.json`、`LICENSE`、`THIRD-PARTY.md`、`cordis.patch.yml`、`locale/`。
- 不在提交里带 `lib/`（构建产物被 `.gitignore` 排除）、`node_modules/`、`.tmp/`、`.tmp-*`。
- 改文档后按 [docs/AGENTS.md](docs/AGENTS.md) 检查「事实是否只有一个家」，并确认相对链接可打开。

## 发版流程

摘要（完整步骤与验证结果见 [发版手册](docs/cookbook/release.md)）：

1. 确认 `package.json` 版本与 `docs/history/releases.md` 对应段落一致（发版记录由主线写，本仓内容提交不擅自升版本）。
2. `npm run build` → `node scripts/verify-build.mjs` → `npm test`（带时间上限）。
3. `npm pack` 检查包内容（`lib`、`THIRD-PARTY.md`、`cordis.patch.yml`、`locale/*.json`、`icon.svg`），并确认 `lib/` 里没有旧运行域模块。
4. `npm publish` 到 `@feiyueve` 私源（scope 已在 `~/.npmrc` 指向私源）。
5. **从私源装回去对账**：在容器测试台里 `dsh plugin add` 私源版本、跑 `scripts/e2e-bpmn.sh`、核对版本与 `/health`。
6. 登记：父仓库 `PLUGINS.md` 的插件行与兼容矩阵。

发版前最好在容器测试台里先验收一遍：[容器测试台](docs/cookbook/run-container-testbed.md)。**不要用宿主 `~/.dsh` 的 web / staging profile 试错。**
