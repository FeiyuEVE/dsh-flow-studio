# 怎么用容器测试台验收

`scripts/e2e-docker.sh` 把当前仓库打包、装进一个**独立测试台容器**里的 dsh，用**桩引擎**真跑一次完整 run，再逐条断言事件、指标、打回、worktree、收件箱与落盘。它验证的是「装进去之后还能不能工作」，不验证模型输出质量。

## 0. 前置条件

- 已存在测试台容器（默认名 `dsh-testbed-fs`），容器内有 Node 与 `pnpm`；`worktree` 相关断言需要容器内有 `git`（脚本会只在容器里装）。
- 宿主端口默认 `3121`，容器内 `/testbed` 为测试台根目录（`/testbed/home` 是 `DSH_HOME`，`/testbed/prefix` 放 dsh 可执行文件）。
- 依赖的宿主机命令：`docker`、`curl`、`openssl`（或 node 兜底）、`node`。
- **不许拿宿主 `~/.dsh` 的 web / staging profile 试错**：测试台的 `DSH_HOME` 是容器内独立目录，宿主 `~/.dsh` 不挂载。

可用环境变量覆盖：`TESTBED_CONTAINER`、`TESTBED_PORT`、`TESTBED_ROOT_IN_CONTAINER`、`TESTBED_FS_TOKEN`、`KEEP=1`。

## 1. 跑一次

```sh
bash scripts/e2e-docker.sh
```

脚本自己完成：`npm run build` → `npm pack` → 把 tgz 拷进容器 → 在容器 profile 里用包管理器安装（**不解包**）→ 用 `FLOW_STUDIO_STUB_ENGINE=1` 重启容器内 dsh → 换宿主登录 cookie + 插件令牌 → 建流程并启动 run → 轮询到收口 → 断言。

预期结束时打印 `Docker e2e 全部通过（版本 <ver>，容器 <name>）`。

## 2. 它断言什么

按脚本自己打印的 `==>` 阶段编号：

- **0. 前置检查**：容器存在、宿主端口可达；记录宿主 `dsh-web` 的 active 状态与启动时间作为隔离基线。**0b** 在容器内确认 `git --version`（worktree 是 git 行为，没有 git 验不了；只在容器里装）。
- **1. 构建 + 打包**：`npm run build` 与 `npm pack --pack-destination .tmp/` 成功，tgz 存在。
- **2. 装进 profile**：用 `pnpm install`（包管理器，不手工解包）；断言容器内 `package.json` 版本等于仓库版本。
- **3. 用桩引擎重启**：`MainThread` / `node` 进程被清掉后用 `FLOW_STUDIO_STUB_ENGINE=1` 重启；从日志取一次性登录令牌换 cookie（期望 303）。同时做鉴权回归：无凭据访问 `GET /runs` 必须 401/403；只有宿主 cookie、没有插件令牌也必须 401/403；`/health` 的 `engine` 必须是 `stub`。
- **4. 建流程并启动**：自建一条「需求分析（skill×2）→ 测试（skill×1，打回需求分析）→ 完成」的链；新建 run 必须是 `pending`；`POST /start` 必须是 200/202（v0.8.1 起错误不许被 `|| true` 吞掉，曾因此静默 400、run 一直 pending）。
- **5. 轮询到收口**：最多 120s；最终状态必须是 `done`。
- **6. 断言**：`run/start` / `run/end`、`node/start` / `node/end` 齐全；至少一次 `reject/trigger`；存在 `attempt=2`（打回后重跑）；token 四桶合计等于 `total`；`quality.state === 'unknown'` 且 label 带「桩」（桩数据必须可辨认，不许给绿灯）；acceptance / progress 有值。**6b** 的 v0.7 / v0.8 组另覆盖 worktree、外部 executor、内建 supervision、节点闹钟与收件箱，并清理测试现场。
- **7. 导出与落盘**：`GET /export` 返回 markdown；run 目录权限是 0700。
- **8. 清理 run 与流程**：删掉本次 run 与流程。
- **9. 宿主隔离回归**：只读 `systemctl`，断言宿主 `dsh-web` 仍 `active` 且 `ActiveEnterTimestamp` 没变——证明这次验收没有碰宿主服务。

## 3. 失败时怎么取证

- 默认失败会打印容器 `docker logs` 尾部与最近 run 目录；再加 `KEEP=1` 保留现场：

```sh
KEEP=1 bash scripts/e2e-docker.sh
```

- 中间产物都在仓库 `.tmp/`：`e2e-health.json`、`e2e-install.log`、`e2e-cookies.txt`、tgz、`e2e-evidence/`（隔离与清理报告）。它们都被 `.gitignore` 排除。
- 想单独看容器日志：

```sh
docker logs --tail 100 dsh-testbed-fs
```

## 4. 什么时候必须跑

- 改「安装后行为」：Host 路由、鉴权、事件写入、聚合、worktree、收件箱、模型工具。
- 发版前（见 [发版](release.md)）：在容器里装**私源产物**再跑一遍。
- 只改文档或纯 CSS 时不必跑；改前端组件至少跑 `node test/render.test.mjs`。

## 5. 相关文档

- 发版步骤：[release.md](release.md)
- 事件契约（脚本断言的口径）：[reference/run-log.md](../reference/run-log.md) → [design/05](../design/05-run-log.md)
- 为什么用容器测试台：`AGENTS.md` 的「插件验证在容器测试台里做」（父仓库约定）
