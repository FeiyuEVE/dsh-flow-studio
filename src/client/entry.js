/**
 * 浏览器端 bundle 的加载入口。
 *
 * `id` 必须等于 npm 包名：DSH 的客户端模块表拿 boot 图行的 id 与注册 id 比对，
 * 不一致会让整棵客户端插件图加载失败。
 *
 * @module @feiyueve/dsh-flow-studio/client/entry
 */

import { createPlugin } from './plugin.js'

window.__ModuleLoader__.load({
  id: '@feiyueve/dsh-flow-studio',
  factory(require) {
    return createPlugin(require)
  },
})
