# 怎么发一个版本

发布到 `@feiyueve` 私源。顺序固定：**先发私源 → 再从私源安装 → 逐文件对账**；不要在发布前跳过任何一步门禁。

## 1. 定版本与历史

```sh
# 看当前版本与未提交改动
node -p "require('./package.json').version"
git status --short
```

1. 改 `package.json` 的 `version`（本仓当前 0.9.0）。
2. 在 [docs/history/releases.md](../history/releases.md) 加对应版本段落，写清新增 / 修复 / 已知边界；不要在 README 里写版本历史。
3. 确认 `THIRD-PARTY.md` 与 `LICENSE` 不需要更新（新增依赖或 vendored 代码必须更新）。

## 2. 构建

```sh
npm install          # 只在依赖变化时需要
npm run build
```

预期：`lib/client.js` 是 esbuild 单文件（≈403 KB，含 React Flow 12），Host 模块被复制进 `lib/`。构建末尾门禁会核对清单、`lib/` 的 `.js` 集合与 `src↔lib` 逐字节一致。

## 3. 发布前校验

```sh
node scripts/verify-build.mjs
```

必须看到三行 ✓：`src ↔ lib 逐字节一致（N 个 Host 模块）`、`lib/ 下 .js 数量 N 与清单一致`、`package.json 的 main 入口存在`。任何一项失败都非零退出——先修，不要带着「陈旧 lib」发包。

## 4. 跑测试

```sh
timeout 300 node --max-old-space-size=2048 test/build.test.mjs
timeout 300 npm test
```

`npm test` 会先跑 `pretest`（强制 build），再跑 22 个自检文件。**带时间上限**：测试纪律与 2026-11-07 的内存事故见 [CONTRIBUTING § 测试纪律](../../CONTRIBUTING.md#测试纪律)。

## 5. 检查包内容

```sh
rm -rf .tmp/pack && mkdir -p .tmp/pack
npm pack --pack-destination .tmp/pack
tar -tzf .tmp/pack/feiyueve-dsh-flow-studio-<版本>.tgz | sort
```

必须包含：`package/package.json`、`package/lib/*.js`、`package/THIRD-PARTY.md`、`package/cordis.patch.yml`、`package/locale/*.json`、`package/icon.svg`。

**不该出现**：`src/`、`test/`、`scripts/`、`README.md` 之外的仓库文件、`node_modules/`、`.tmp*`、`*.tgz`。`files` 白名单在 `package.json`，改它要同时改这里与 `docs/AGENTS.md`（如果涉及文档）。

## 6. 发布到私源

```sh
npm publish
```

`@feiyueve` scope 在 `~/.npmrc` 已指向私源；`prepack` 会再 build 一次（幂等）。发布后确认：

```sh
npm view @feiyueve/dsh-flow-studio version
```

返回值必须等于刚发的版本。

## 7. 从私源装回去对账

在**容器测试台**里装私源产物（不用宿主 profile 试错）：

1. 按 [容器测试台](run-container-testbed.md) 起环境，把安装源从本地 tgz 换成私源版本：`dsh plugin --profile web add @feiyueve/dsh-flow-studio@<版本>`。
2. 核对容器内 `node -p "require('<profile>/node_modules/@feiyueve/dsh-flow-studio/package.json').version"` 等于发布版本。
3. 逐文件对账：私源 tgz 解出的 `lib/*.js` 与容器内安装产物 byte-for-byte 一致（`sha256sum` 两边对比）。
4. 跑端到端：`bash scripts/e2e-docker.sh`，看到 `Docker e2e 全部通过`。
5. 查 `/health`：`version` 是新版本、`engine` 与 `auth` 符合预期。

## 8. 登记

- 父仓库 `PLUGINS.md`：更新插件行的版本与兼容矩阵（`peerDependencies` 显式列 dsh 版本，禁 `*`）。
- 如果这版改了事件契约，确认 [design/05](../design/05-run-log.md) 已更新、`reference/run-log.md` 只是链接没有复制。
- 需要时在 `CHANGES.md` 记录对 dsh 核心的本地改造（本插件通常不涉及）。

## 9. 收尾检查清单

- [ ] `package.json` 版本 = 历史段落 = 私源 `npm view` 版本
- [ ] `node scripts/verify-build.mjs` 三行 ✓
- [ ] `npm test` 全绿（带 timeout / heap 上限）
- [ ] `npm pack` 内容清单符合预期（无 `src` / `test` / `scripts`）
- [ ] 私源装回容器后版本与 sha256 对账一致
- [ ] 容器 e2e 通过、宿主 `dsh-web` 未被重启
- [ ] `PLUGINS.md` 已登记
