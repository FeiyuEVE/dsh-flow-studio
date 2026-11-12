# 第三方代码（Third-party notices）

本插件的运行时 npm 依赖有十个：`bpmn-engine`（精确 `26.0.6`）、`lru-cache`（`^11.5.3`）、
`@modelcontextprotocol/sdk`（精确 `1.32.2`，`flow_finish_node` 的 stdio MCP server）、
`@agentclientprotocol/sdk`（精确 `2.6.0`，ACP v1 客户端连接层）与 `zod`（精确 `4.6.7`，
ACP SDK 的 peer 依赖），以及 `bpmn-elements` / `bpmn-moddle` / `moddle-context-serializer` /
`smqp` / `debug` 这五个 BPMN 栈件。**它们必须全部显式声明**：`bpmn-engine` 自己没有 `dependencies`，
只把栈件写在 `peerDependencies` 里，而 pnpm 布局的 dsh profile **不会自动安装传递依赖的
peerDependencies**——2026-11-11 在容器测试台实测：只声明 `bpmn-engine` 时插件 import 直接
失败（`Cannot find package 'bpmn-moddle' imported from .../bpmn-engine/src/index.js`）。
把它们写成直接依赖后测试台正常加载。除此之外的第三方代码（BPMN 元模型、
FEEL 求值、Zeebe 扩展描述符）一律**编译成单文件 ESM 提交进仓库**，不通过 npm 依赖安装，
因此需要在这里保留完整许可文本。

按形态分两类：

- **npm 依赖**：上面十个 —— 不复制进本仓库，跟随 npm 安装。
- **vendored**：`bpmn-moddle`、`feelin`、`zeebe-bpmn-moddle` —— 单文件 ESM 放在
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

## @agentclientprotocol/sdk@2.6.0

- **用途**：ACP v1 客户端连接层。`src/acp-client.js` 用它的稳定入口
  （`ndJsonStream` / `client` / `methods` / `RequestError`）做 NDJSON 分帧、JSON-RPC
  双向路由与 32 MiB 单行上限；`src/agent-adapter-acp.js` 的 probe / 运行期都经它建立
  连接。**只有 `src/acp-client.js` 直接 import 它**（懒加载 `await import('@agentclientprotocol/sdk')`），
  `agent-adapter-acp.js` 只经 P1 的连接层使用。
- **来源**：npm 依赖，`https://github.com/agentclientprotocol/typescript-sdk`
- **形态**：**npm 直接依赖**（`package.json` 里精确 `2.6.0`），不随 `lib/` 拷贝、
  不 vendor、不 bundle；安装后代码来自 `node_modules/`。
- **为什么锁精确版本**：ACP 协议版本、客户端入口形状与 `RequestError` 错误结构都来自
  这份 SDK；小版本漂移会改变对 agent 的握手契约，所以 `package.json` 固定为 `2.6.0`。
- **peer 依赖**：`zod`（非 optional，本插件已直接声明为 `4.6.7`）；
  `@modelcontextprotocol/server` 是 optional peer，本插件不使用、不安装。
- **许可**：Apache-2.0。

### License

```

                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   Copyright 2025 Zed Industries, Inc. and contributors

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

## zod@4.6.7

- **用途**：`@agentclientprotocol/sdk` 的 peer 依赖（ACP 消息 schema 校验）。本插件不直接
  import `zod`，但 pnpm 布局的 dsh profile 不会自动安装传递依赖的 peer，所以显式声明为
  直接依赖并锁精确版本。
- **来源**：npm 依赖，`https://github.com/colinhacks/zod`
- **形态**：**npm 直接依赖**（`package.json` 里精确 `4.6.7`），不复制进 `lib/`、不 vendor。
- **许可**：MIT。版权行：`Copyright (c) 2025 Colin McDonnell`。

### License

```
MIT License

Copyright (c) 2025 Colin McDonnell

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

# 二、vendored 代码（单文件 ESM，提交进仓库）

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
