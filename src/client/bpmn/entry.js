/**
 * 画布 chunk（`lib/client.bpmn.js`）入口。
 *
 * 宿主协议：
 *   window.__ModuleLoader__.load({
 *     id: '@feiyueve/dsh-flow-studio',
 *     chunk: 'client.bpmn.js',
 *     factory: require => module.exports,
 *   })
 *
 * 本阶段（0.13.3 步骤 2）只放**最小可验证实现**：导出 `version` 与占位的
 * `mountEditor()`，用来打通「主包 → require.async('./client.bpmn.js') → chunk
 * factory → 挂载/销毁」这条链，并让构建能稳定测出 chunk 体积。真正的 bpmn-js
 * Modeler 与官方属性面板在步骤 3 接入；接入时保持同一出口形状，壳不用改。
 *
 * 顶层不得访问 `document` / `window`：chunk 只在浏览器里加载，但保持可被裸 Node
 * factory 冒烟测试求值（不创建 DOM）。
 *
 * @module @feiyueve/dsh-flow-studio/client/bpmn/entry
 */

/** chunk 版本号：壳把它显示在就绪状态里，也用于协议冒烟断言。 */
export const version = '0.13.3-phase2'

/**
 * 在宿主提供的容器里挂载画布。
 *
 * 步骤 3 会替换成 bpmn-js Modeler；本阶段的占位实现只写一个带协议标记的节点，
 * 用来证明容器真的传到了 chunk，并且 `destroy()` 能清干净。
 *
 * @param {HTMLElement} container 壳提供的挂载点（仅在浏览器 effect 里调用）
 * @param {object} [options]
 * @param {string} [options.placeholderText] 占位文案（测试可覆盖）
 * @returns {{version: string, destroy: () => void, isDestroyed: () => boolean}}
 */
export function mountEditor(container, options = {}) {
  if (!container || typeof container.appendChild !== 'function') {
    throw new TypeError('mountEditor(container) 需要一个可挂载的 DOM 容器')
  }
  const doc = container.ownerDocument || (typeof document !== 'undefined' ? document : null)
  if (!doc || typeof doc.createElement !== 'function') {
    throw new Error('mountEditor 需要 DOM 环境')
  }

  const placeholder = doc.createElement('div')
  placeholder.className = 'fs-bpmn-editor-placeholder'
  placeholder.setAttribute('data-bpmn-chunk', 'client.bpmn.js')
  placeholder.setAttribute('data-bpmn-chunk-version', version)
  placeholder.textContent = typeof options.placeholderText === 'string'
    ? options.placeholderText
    : 'BPMN 画布 chunk 已加载；Modeler 将在 0.13.3 步骤 3 接入。'
  container.appendChild(placeholder)

  let destroyed = false
  return {
    version,
    isDestroyed() {
      return destroyed
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      if (placeholder.parentNode === container) container.removeChild(placeholder)
    },
  }
}
