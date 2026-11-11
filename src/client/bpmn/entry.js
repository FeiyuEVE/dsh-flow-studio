/**
 * 画布 chunk（`lib/client.bpmn.js`）入口。
 *
 * 宿主协议（由 scripts/build.mjs 的 banner/footer 包装）：
 *
 *   window.__ModuleLoader__.load({
 *     id: '@feiyueve/dsh-flow-studio',
 *     chunk: 'client.bpmn.js',
 *     factory: require => module.exports,
 *   })
 *
 * 本文件只做出口：真正的 Modeler / 官方属性面板在 `./editor.js`。顶层不访问
 * `document` / `window`，裸 Node 求值 factory 也不会创建 DOM。
 *
 * 控制器（`mountEditor()` 返回值）的命令式接口：
 *   - `ready`：初始 import 完成（成功/失败都 resolve 成 `{ok}`，失败带 `error`）
 *   - `importXML(xml)` / `saveXML(options?)`
 *   - `setViewerMode(enabled)`：实例只读视图用 NavigatedViewer
 *   - `setRuntimeState(markers)`：只加 canvas marker，不改 XML
 *   - `destroy()`
 *
 * @module @feiyueve/dsh-flow-studio/client/bpmn/entry
 */

import { mountEditor as mountBpmnEditor } from './editor.js'

/** chunk 版本号：壳把它显示在就绪状态里，也用于协议冒烟断言。 */
export const version = '0.13.3-phase4'

/**
 * 在宿主提供的容器里挂载 BPMN Modeler + 官方属性面板。
 *
 * @param {HTMLElement} container 壳提供的挂载点（仅在浏览器 effect 里调用）
 * @param {object} [options] 见 `./editor.js` 的 mountEditor
 * @returns {object} 命令式控制器
 */
export function mountEditor(container, options = {}) {
  return mountBpmnEditor(container, options)
}

export { BPMN_EDITOR_CSS } from './styles.js'
