# 第三方代码（Third-party notices）

本仓库是「零运行时依赖」的 DSH 插件：`lib/` 里除自己写的模块外，只有下面这一份 vendored 代码。
它不通过 npm 依赖安装，而是**编译成单文件 ESM 提交进仓库**，因此需要在这里保留完整许可文本。

---

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
