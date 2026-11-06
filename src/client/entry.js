/**
 * 浏览器端 bundle 的加载入口。
 *
 * 构建时 esbuild 用 banner/footer 把整棵模块图包进
 * `window.__ModuleLoader__.load({ id, factory(require) { ... } })` 的 factory 体内，
 * 所以 `require('react')` 在依赖代码求值时也拿得到宿主的模块表 —— 这比「只把
 * 我们自己的入口放进 factory、第三方依赖在 factory 外求值」可靠。
 *
 * `id` 必须等于 npm 包名：DSH 的客户端模块表拿 boot 图行的 id 与注册 id 比对，
 * 不一致会让整棵客户端插件图加载失败。
 *
 * @module @feiyueve/dsh-flow-studio/client/entry
 */

import { createPlugin } from './plugin.js'

export { createPlugin }
