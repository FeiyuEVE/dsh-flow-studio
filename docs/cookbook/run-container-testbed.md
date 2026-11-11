# 怎么用容器测试台验收

`scripts/e2e-bpmn.sh` 把当前仓库打包、装进一个**独立测试台容器**里的 dsh，重启容器内进程，然后**只走 HTTP** 跑一遍 BPMN 定义 → 实例 → 人工任务 → 事件 → 鉴权 → 宿主隔离。它验证的是「装进去之后还能不能工作」，不验证模型输出质量。

0.14.0 起这是**唯一**的新域验收脚本；旧 `scripts/e2e-docker.sh`（旧 `/flows`、`/runs`、打回、supervision）已删除。

## 0. 前置条件

- 已存在测试台容器（默认名 `dsh-testbed-bpmn`），容器内有 Node 与 `pnpm`；worktree / 定义相关断言需要容器内有 `git`（缺时脚本只在容器里装）。
- 宿主端口默认 `3110`；容器内 `/testbed` 为测试台根目录（`/testbed/home` 是 `DSH_HOME`，`/testbed/prefix` 放 dsh 可执行文件）。
- 依赖的宿主机命令：`docker`、`curl`、`openssl`（或 node 兜底）、`node`、`git`。
- **不许拿宿主 `~/.dsh` 的 web / staging profile 试错**：测试台的 `DSH_HOME` 是容器内独立目录，宿主 `~/.dsh` 不挂载。

可用环境变量覆盖：`TESTBED_CONTAINER`、`TESTBED_PORT`、`E2E_RUN_ID`、`E2E_PREFLIGHT_ONLY=1`。

## 1. 跑一次

```sh
bash scripts/e2e-bpmn.sh
```

脚本自己完成：前置身份 / 挂载隔离校验 → `npm run build` → `node scripts/verify-build.mjs` → `npm pack` → 在容器 profile 里用包管理器安装（**不解包**）→ 用一次性插件令牌重启容器内 dsh → 登录换 cookie → 只走 HTTP 跑 `start → userTask → end`。

预期结束时打印 `BPMN 域容器验收通过`。

## 2. 它断言什么

按脚本打印的阶段编号：

- **0**：记录宿主 `dsh-web` 的 active 状态与启动时间作为隔离基线；检查容器内 `git` / `pnpm`。
- **1（前置）**：容器在跑、端口映射与 `TESTBED_PORT` 一致、PID / NET namespace 与宿主隔离；挂载源不是宿主 `$HOME` / 祖先 / `~/.dsh`，只允许 `/testbed` 根 bind（根内嵌套 bind 与写入路径双向重叠一律拒绝）；profile、日志、安装目录与实际写入叶路径的真实路径不落在其它 bind 挂载下。已有监听 3080 的实例时校验它是本容器的 dsh 且日志令牌登录返回 303；没有实例时走 bootstrap（不 kill，由脚本启动 dsh 再登录 303）。全部通过后才做安装 / 杀进程。
- **2**：`npm run build` → `node scripts/verify-build.mjs` → `npm pack`；tgz 内版本等于仓库 `package.json`。
- **3**：用 `sed` 把 profile 依赖指向拷进容器的 tgz，`pnpm install`（不手工解包）；容器内版本等于仓库版本，且 `lib/client.bpmn.js` 与仓库构建产物逐字节一致。
- **4–6**：只终止本容器内监听 3080 的 dsh（按 socket inode 反查 PID，并核对 `comm` / `cwd` / `cmdline`），然后重启并再次核对新监听进程；登录换 cookie 期望 303；`/health` 的 `version`、`ok`、`bpmn.enabled` 正确，`authMode=full` 证明插件令牌生效；**6b** 再断言旧 `/flows`、`/runs`、`/worktrees` 与 `/worktrees/prune` 在认证通过后都是 404。
- **7**：从 `/` 的 `__DSH_BOOT__` 取 flow-studio 入口 rev，`client.bpmn.js?rev=<rev>` 必须 200；去掉宿主追加的 `sourceMappingURL` 尾注后的正文与 `lib/client.bpmn.js` 逐字节一致且含 `bpmn-js`。
- **8**：`POST /definitions` 存带 BPMN DI 的最小定义（`e2e-start → e2e-user-task → e2e-end`）→ 列表 / 详情回读 → `POST /instances` 启动 → 轮询到 `ACTIVE` + `pendingTasks` → `POST /instances/<id>/tasks/e2e-user-task/complete` → `COMPLETED`；事件流含 `activity/end` 与 `process/end`，`GET /instances/<id>/definition` 返回冻结 XML。
- **9**：无 cookie 的 `GET /instances`、只有插件令牌没有 cookie、只有 cookie 没有插件令牌的 `POST /definitions` 都必须 401/403。
- **10**：再读宿主 `dsh-web` 的 active 状态与 `ActiveEnterTimestamp`，未变才算过（验收不碰宿主服务）。

## 3. 失败时怎么取证

- 现场按运行隔离：失败时保留本次 `.tmp/e2e-bpmn/<runId>/`（runId 含时间戳与 pid），不清理其它运行的证据；前置身份校验失败时只打印失败原因、不读取该容器日志、也不改测试台。
- tgz、health 响应、事件 JSON、cookies 与安装日志都在证据目录里；`.tmp/` 已被 `.gitignore` 排除。
- 挂载隔离逻辑另有一个不启动容器的桩演练：`node test/e2e-mount-isolation.test.mjs`。

## 4. 相关契约

- 定义 / 实例路由与字段：[实例域接口](../reference/instance-api.md)
- 事件契约：[design/10](../design/10-bpmn-instance-api.md)
- 发版时的完整对账步骤：[发版](release.md)
