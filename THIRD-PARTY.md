# 第三方代码（Third-party notices）

本插件的运行时 npm 依赖有八个：`bpmn-engine`（精确 `26.0.6`）、`lru-cache`（`^11.5.3`）、
`@modelcontextprotocol/sdk`（精确 `1.32.2`，`flow_finish_node` 的 stdio MCP server）、
以及 `bpmn-elements` / `bpmn-moddle` / `moddle-context-serializer` / `smqp` / `debug`
这五个 BPMN 栈件。**它们必须全部显式声明**：`bpmn-engine` 自己没有 `dependencies`，
只把栈件写在 `peerDependencies` 里，而 pnpm 布局的 dsh profile **不会自动安装传递依赖的
peerDependencies**——2026-11-11 在容器测试台实测：只声明 `bpmn-engine` 时插件 import 直接
失败（`Cannot find package 'bpmn-moddle' imported from .../bpmn-engine/src/index.js`）。
把它们写成直接依赖后测试台正常加载。除此之外的第三方代码（xstate、BPMN 元模型、
FEEL 求值、Zeebe 扩展描述符）一律**编译成单文件 ESM 提交进仓库**，不通过 npm 依赖安装，
因此需要在这里保留完整许可文本。

按形态分两类：

- **npm 依赖**：上面八个 —— 不复制进本仓库，跟随 npm 安装。
- **vendored**：`xstate`、`bpmn-moddle`、`feelin`、`zeebe-bpmn-moddle` —— 单文件 ESM 放在
  `src/*-vendor.js`，构建时逐字节复制到 `lib/`。其中 `bpmn-moddle` 同时是 npm 依赖
  （引擎运行期要用它）和 vendored 产物（我们自己的解析器用它与主世界隔离）——两份用途不同，
  升级时要一起核对版本。

`bpmn-js` 是**构建期**依赖（打进 `lib/client.js`），许可与义务单列在第四节。

---

# 一、npm 依赖（非 vendored）

## bpmn-engine@26.0.6

- **用途**：BPMN 2.0 流程执行引擎（`docs/design/` 的 BPMN 执行链路）。
- **来源**：npm 依赖，`https://github.com/paed01/bpmn-engine`
- **为什么锁精确版本**：这个包由单人维护，caret range（`^26.0.6`）会在无人察觉时把小版本
  漂移带进来；执行语义又直接决定流程行为，所以 `package.json` 里固定为 `26.0.6`。
- **它的 peer 依赖**（本插件**直接声明**为 dependencies，不能靠 peer 自动装）：
  `bpmn-elements ^18.1.1`、`bpmn-moddle ^10.3.1`、`debug ^4.4.3`、
  `moddle-context-serializer ^6.0.2`、`smqp ^15.0.0`。
  理由与实测证据见文首「必须全部显式声明」一段。
- **许可**：MIT。

### License

```
The MIT License (MIT)

Copyright (c) 2019 Pål Edman

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## lru-cache@11.5.3

- **用途**：`src/bpmn-runner.js` 管活跃 BPMN 实例的 LRU（默认上限 100，见
  `FLOW_STUDIO_BPMN_MAX_ACTIVE`）。自己写一个「有容量上限、能淘汰、淘汰前必须检查快照」
  的容器容易错在淘汰时机，所以用这个库而不是手搓。
- **来源**：npm 依赖，`https://github.com/isaacs/node-lru-cache`
- **许可**：**Blue Oak Model License 1.0.0**（不是 MIT；它对使用者很宽松，但有
  `Notices` 义务：拿到这份代码的人也要拿到许可文本或指向许可页面的链接）。
  本文件下方保留完整文本，同时每份安装产物里也会带 `node_modules/lru-cache/LICENSE.md`。
- **为什么允许它进运行时**：它是纯 JS、无原生模块、无安装脚本，版本范围 `^11.5.3` 只在
  同一大版本内漂移；语义只影响「内存里保留几个实例」，不影响流程执行结果。

### License (Blue Oak Model License 1.0.0)

```
# Blue Oak Model License

Version 1.0.0

## Purpose

This license gives everyone as much permission to work with
this software as possible, while protecting contributors
from liability.

## Acceptance

In order to receive this license, you must agree to its
rules.  The rules of this license are both obligations
under that agreement and conditions to your license.
You must not do anything with this software that triggers
a rule that you cannot or will not follow.

## Copyright

Each contributor licenses you to do everything with this
software that would otherwise infringe that contributor's
copyright in it.

## Notices

You must ensure that everyone who gets a copy of
any part of this software from you, with or without
changes, also gets the text of this license or a link to
<https://blueoakcouncil.org/license/1.0.0>.

## Excuse

If anyone notifies you in writing that you have not
complied with [Notices](#notices), you can keep your
license by taking all practical steps to comply within 30
days after the notice.  If you do not do so, your license
ends immediately.

## Patent

Each contributor licenses you to do everything with this
software that would otherwise infringe any patent claims
they can license or become able to license.

## Reliability

No contributor can revoke this license.

## No Liability

***As far as the law allows, this software comes as is,
without any warranty or condition, and no contributor
will be liable to anyone for any damages related to this
software or this license, under any kind of legal claim.***
```

---

## @modelcontextprotocol/sdk@1.32.2

- **用途**：模型工具 `flow_finish_node` 的 stdio MCP server。`src/node-finish-mcp.js` 用
  `Server` + `StdioServerTransport` 对外暴露 `flow_finish_node`（`tools/list` /
  `tools/call`），并用 `Client` + `StdioClientTransport` 起子进程做通道自检。
  **只有这一个模块** import 它。
- **来源**：npm 依赖，`https://github.com/modelcontextprotocol/typescript-sdk`
- **形态**：**npm 直接依赖**（`package.json` 里精确 `1.32.2`），不是 vendored——不随
  `lib/` 拷贝、不进 `src/*-vendor.js`，安装后代码来自 `node_modules/`。
- **为什么锁精确版本**：工具名、`tools/list` 的入参 schema、`tools/call` 的错误结构都
  直接来自这份 SDK；小版本漂移会改变对模型暴露的契约，所以 `package.json` 固定为 `1.32.2`。
- **许可**：MIT。版权行：`Copyright (c) 2024 Anthropic, PBC`。

### License

```
MIT License

Copyright (c) 2024 Anthropic, PBC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 传递依赖

- **规模**：按 `package-lock.json` 从 `node_modules/@modelcontextprotocol/sdk` 出发的
  依赖闭包共 **91 个包**（去重后的 name@version）。按安装路径计 94 份：
  `content-type@2.1.0` 在 `express` / `body-parser` / `type-is` / `negotiator` 下各装了一份。
- **许可分布**（按闭包内每个包 `license` 字段归类，91 个）：

  | 许可 | 包数 | 性质 |
  | --- | --- | --- |
  | MIT | 81 | 宽松 |
  | ISC | 7 | 宽松（与 MIT 实质等价） |
  | BSD-3-Clause | 2 | 宽松 |
  | BSD-2-Clause | 1 | 宽松 |

  非 MIT 的 10 个包逐个列出：`fast-uri@3.1.9`（BSD-3-Clause）、`qs@6.17.1`
  （BSD-3-Clause）、`json-schema-typed@8.0.2`（BSD-2-Clause）、`inherits@2.0.4`、
  `isexe@2.0.0`、`once@1.4.0`、`setprototypeof@1.2.0`、`which@2.0.2`、`wrappy@1.0.2`、
  `zod-to-json-schema@3.25.2`（后七个均 ISC）。
- **非宽松许可证**：闭包内**未发现** copyleft / 非宽松许可证——没有 GPL / AGPL / SSPL /
  CC-BY-NC / UNLICENSED / 自定义许可，也没有缺失 `license` 字段的包。另外逐个核对了磁盘上
  94 份 `node_modules/*/package.json` 的 `license` 与 `package-lock.json`：0 处不符，
  94 个包各自都带 `LICENSE` / `COPYING` 文件。
- **复算方式**：按 `package-lock.json` 的 `packages` 闭包统计（用 Node 的向上查找
  `node_modules` 规则解析每个依赖），一次性脚本 `./.tmp/mcp-closure.mjs`（已删）。
- **版本与 peer 核对**：`npm ls @modelcontextprotocol/sdk` 没有 extraneous / unmet，
  输出为 `@feiyueve/dsh-flow-studio@0.12.3` → `└── @modelcontextprotocol/sdk@1.32.2`。
  它的 `peerDependenciesMeta` 里 `@cfworker/json-schema` 是 optional、`zod` 非 optional；
  而 `zod`（实际安装 `4.6.7`）同时是它的直接依赖，所以 pnpm 不自动装 peer 也不会缺。

---

# 二、vendored 代码（单文件 ESM，提交进仓库）

## xstate@5.33.3

- **用途**：流程状态机内核（节点之间的转移、守卫、打回、重放），见 `docs/design/08-state-machine.md`。
- **来源**：[github.com/statelyai/xstate](https://github.com/statelyai/xstate)，`npm pack xstate@5.33.3`
- **tarball shasum**：`6dc145fea93544377056cdb3f2958ef97bd99ad1`
- **tarball integrity**：`sha512-AnDRjS/GyKHmbA1PyhVCYBqYsA7EGe3KGgeD0ht3NFsXzoz7leX/HQDFX9QlHFJ/ltLHPsgChJYwPzRvB/0b4g==`
- **vendor 路径**：`src/xstate-vendor.js`（构建时复制到 `lib/xstate-vendor.js`）
- **做了哪些改动**：**只做 bundle，未修改其逻辑**。打包方式
  `esbuild --bundle --format=esm --platform=neutral`（未压缩，保留可读性便于按需打补丁）。
  文件头部记录了版本、shasum、esbuild 版本与重新生成方式。
- **重新生成**：`node scripts/vendor-xstate.mjs`；校验已提交产物是否与脚本一致：
  `node scripts/vendor-xstate.mjs --check`（幂等，字节级可复现）。
- **升级条件**：主版本升级（v6 目前在 beta）必须先跑完 `docs/design/08-state-machine.md` §9 的验收，
  尤其是「快照不兼容 → 事件重放」这条。

### License

```
The MIT License (MIT)

Copyright (c) 2015 David Khourshid

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## bpmn-moddle@10.3.1

- **用途**：BPMN 2.0 元模型与 XML 读写（`BpmnModdle.fromXML` / `toXML`），流程模板的导入导出。
- **来源**：[github.com/bpmn-io/bpmn-moddle](https://github.com/bpmn-io/bpmn-moddle)，`npm pack bpmn-moddle@10.3.1`
- **tarball shasum**：`e674706d6b039a9ea88129788e6df91842aaf832`
- **tarball integrity**：`sha512-xjJ8GzseRkjjM0MX/rODVB6iv+rhGLt8FCHJIovLAjJsDEAUjITfyiJZYczJ4pp3wmesbY3sQR7eRT+q5uroVA==`
- **vendor 路径**：`src/bpmn-moddle-vendor.js`（构建时复制到 `lib/bpmn-moddle-vendor.js`）
- **打包进来的依赖闭包**（版本锁死）：`moddle@8.2.1`、`moddle-xml@12.3.2`、
  `min-dash@5.1.0`、`saxen@11.2.0`。
- **做了哪些改动**：**只做 bundle，未修改其逻辑**。`esbuild --bundle --format=esm
  --platform=neutral`（未压缩），默认的 BPMN 元模型（bpmn / bpmndi / dc / di / bioc / color）
  已由包自己内联在 `dist/index.js` 里。
- **重新生成**：`node scripts/vendor-bpmn.mjs`；校验：`node scripts/vendor-bpmn.mjs --check`。

### License

```
The MIT License (MIT)

Copyright (c) 2014 camunda Services GmbH

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## feelin@8.2.0

- **用途**：FEEL 表达式解析与求值（网关条件、输入输出映射、脚本任务），
  单文件产物导出 `evaluate` / `parseExpression` / `parseUnaryTests` 等 23 个符号。
- **来源**：[github.com/camunda/feelin](https://github.com/camunda/feelin)，`npm pack feelin@8.2.0`
- **tarball shasum**：`78793b2e6372a5dcb0fd2215eceaafd6f8088798`
- **tarball integrity**：`sha512-o/oUBp7hzcsupV3Pf+Kn+43y+gul/sSVqYYkJq9+hkYuFuBfk0rocy//H2goKlWJJbuONnE59Iqb4U34VyZpjA==`
- **vendor 路径**：`src/feelin-vendor.js`（构建时复制到 `lib/feelin-vendor.js`）
- **打包进来的依赖闭包**（版本锁死）：`lezer-feel@3.0.1`、`@lezer/common@1.5.5`、
  `@lezer/highlight@1.2.5`、`@lezer/lr@1.4.12`、`min-dash@5.1.0`、
  `temporal-polyfill@1.0.8`、`temporal-utils@1.0.4`。`temporal-spec@1.0.1` 也在
  `temporal-polyfill` 的依赖里，但本产物没有引用它的代码（只用于类型/规范辅助）。
- **做了哪些改动**：**只做 bundle，未修改其逻辑**。`esbuild --bundle --format=esm
  --platform=neutral`（未压缩）。
- **重新生成**：`node scripts/vendor-bpmn.mjs`；校验：`node scripts/vendor-bpmn.mjs --check`。

### License

```
The MIT License (MIT)

Copyright (c) 2019-present Nico Rehwaldt

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## zeebe-bpmn-moddle@2.0.0

- **用途**：Camunda / Zeebe 的 BPMN 扩展描述符（`zeebe:taskDefinition`、`zeebe:ioMapping`、
  `zeebe:input` / `zeebe:output` 等）。产物把包里的 `resources/zeebe.json` 内联成 ESM，
  导出 `zeebeModdle`（同时作为 default 导出），交给 `new BpmnModdle({ zeebe: zeebeModdle })`。
- **来源**：[github.com/camunda/zeebe-bpmn-moddle](https://github.com/camunda/zeebe-bpmn-moddle)，
  `npm pack zeebe-bpmn-moddle@2.0.0`
- **tarball shasum**：`98a831b274cda54c3d1769c661e4e70a1711f4ca`
- **tarball integrity**：`sha512-n1wtWbvpWRA4ROgbjNpFt6SxvSGp+lJHuY+N6hXp7IrxV/VJnfnwrm+UMGY80IgZMdJVz9zgKyPC4QujijBH8w==`
- **vendor 路径**：`src/zeebe-moddle-vendor.js`（构建时复制到 `lib/zeebe-moddle-vendor.js`）
- **依赖**：包本身没有运行时依赖（只有 `moddle >=8.2.0` 的 peer 声明）；产物就是那份 JSON，
  用 esbuild 内联，没有引入其它代码。
- **重新生成**：`node scripts/vendor-bpmn.mjs`；校验：`node scripts/vendor-bpmn.mjs --check`。

### License

```
The MIT License (MIT)

Copyright (c) 2020-present Camunda Services GmbH

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

---

# 三、随 vendored 产物一起打包的传递依赖

这些包没有单独的 `src/*-vendor.js`，它们的代码被 esbuild 内联进上面某个产物。
全部是 MIT；各自的版权行如下，MIT 许可正文见上一节（同一份文本覆盖这些包）。

| 包 | 版本 | 许可 | 版权行 | 被谁内联 |
| --- | --- | --- | --- | --- |
| `moddle` | 8.2.1 | MIT | Copyright (c) 2014-present Camunda Services GmbH | bpmn-moddle |
| `moddle-xml` | 12.3.2 | MIT | Copyright (c) 2014-present Camunda Services GmbH | bpmn-moddle |
| `min-dash` | 5.1.0 | MIT | Copyright (c) 2017-present camunda Services GmbH | bpmn-moddle / feelin |
| `saxen` | 11.2.0 | MIT | Copyright (c) 2012 Vopilovskii Konstantin；Copyright (c) 2017-present Nico Rehwaldt | bpmn-moddle |
| `lezer-feel` | 3.0.1 | MIT | Copyright (C) 2020 by Nico Rehwaldt and others | feelin |
| `@lezer/common` | 1.5.5 | MIT | Copyright (C) 2018 by Marijn Haverbeke and others | feelin |
| `@lezer/highlight` | 1.2.5 | MIT | Copyright (C) 2018 by Marijn Haverbeke and others | feelin |
| `@lezer/lr` | 1.4.12 | MIT | Copyright (C) 2018 by Marijn Haverbeke and others | feelin |
| `temporal-polyfill` | 1.0.8 | MIT | Copyright (c) 2026 Adam Shaw | feelin |
| `temporal-utils` | 1.0.4 | MIT | Copyright (c) 2026 Adam Shaw | feelin |

> `temporal-spec@1.0.1` 是 Apache-2.0（版权行：Copyright 2026 Adam Shaw，部分代码来自
> TypeScript 项目，Copyright (c) Microsoft Corporation）。它只被 `temporal-polyfill`
> 用于类型/规范辅助，当前 vendored 产物没有包含它的代码；如果将来升级到会内联它的版本，
> 必须在这里补上 Apache-2.0 全文与 NOTICE。

---

# 四、画布组件：bpmn-js 的 bpmn.io License（不是 MIT）

工作流画布用 `bpmn-js`（构建期依赖，打进画布 chunk `lib/client.bpmn.js`，不 vendor
进 `src/`；主包 `lib/client.js` 不含 bpmn-js / diagram-js / 官方属性面板）。它的许可是
**bpmn.io License**：MIT 条款 + 一条额外的水印条款。

同一 chunk 里还打进了下列官方包（均为构建期依赖，随 `lib/client.bpmn.js` 分发）：

| 包 | 版本 | 许可 | 说明 |
|---|---|---|---|
| `bpmn-js` | 18.31.1 | bpmn.io License（见下） | 画布、palette、右键菜单、替换菜单、水印 |
| `diagram-js` | 15.28.1 | MIT | bpmn-js 的底层图引擎 |
| `bpmn-js-properties-panel` | 5.65.3 | MIT | 官方属性面板（BpmnPropertiesPanel / BpmnPropertiesProvider） |
| `@bpmn-io/properties-panel` | 3.59.0 | MIT | 面板组件与 Preact runtime 副本（`properties-panel/preact`） |
| `@bpmn-io/*`（feel / codemirror 等传递依赖） | 见 `package-lock.json` | MIT | 由官方属性面板引入，随 chunk 打包 |
| `bpmn-font`（`bpmn-js/dist/assets/bpmn-font`） | 随 bpmn-js 18.31.1 | 随 bpmn-js 包分发 | 图标字体；构建时 woff2 以 base64 内联 |

官方 CSS（`diagram-js/assets/diagram-js.css`、`bpmn-js/dist/assets/bpmn-js.css`、
`@bpmn-io/properties-panel/dist/assets/properties-panel.css`）也随 chunk 内联，见
`scripts/build-bpmn-assets.mjs`。

- **对使用者的要求**：负责渲染 `https://bpmn.io` 水印的源码**不得删除或修改**；当软件用在
  网站或应用里时，水印必须**完整可见、不能被其它元素遮挡**。所以画布上会一直带着 bpmn.io
  水印，这是许可要求，不是可以关掉的 UI 选项。
- **已确认接受**：这一点已由用户确认（2026-11-11）：接受画布带 bpmn.io 水印，不遮挡它。
- **注意**：`scripts/build.mjs` 打包两个客户端产物时都用 `legalComments: 'none'`，会把
  bpmn-js 等依赖的 license banner 从 `lib/client.js` / `lib/client.bpmn.js` 里剥掉；因此
  这份 `THIRD-PARTY.md` 会随包分发（`package.json` 的 `files` 白名单包含它），由它承担
  许可原文的告知义务。**不要**把这份文件从 `files` 里删掉。

### License

```
Copyright (c) 2014-present Camunda Services GmbH

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in the
Software without restriction, including without limitation the rights to use, copy,
modify, merge, publish, distribute, sublicense, and/or sell copies of the Software,
and to permit persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

The source code responsible for displaying the bpmn.io project watermark that
links back to https://bpmn.io as part of rendered diagrams MUST NOT be
removed or changed. When this software is being used in a website or application,
the watermark must stay fully visible and not visually overlapped by other elements.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE
OR OTHER DEALINGS IN THE SOFTWARE.
```
