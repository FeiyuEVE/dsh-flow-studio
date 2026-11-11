/**
 * bpmn-js Modeler / NavigatedViewer 生命周期与命令式接口（chunk 内实现）。
 *
 * 挂载结构：
 *
 *   container
 *     └ .fs-bpmn-editor
 *         └ .fs-bpmn-editor-main
 *             ├ .fs-bpmn-editor-canvas      ← Modeler / Viewer 的 container
 *             └ .fs-bpmn-editor-properties  ← 官方属性面板的 parent
 *
 * 关键约束（0.13.3 步骤 3–4）：
 *   - `fs:` 描述符每次实例化都取新副本（`createFsModdlePackage()`），不复用会被
 *     bpmn-moddle 就地改名的对象；Zeebe 描述符同样拷贝；
 *   - 官方水印由 bpmn-js 自己加在 `.bjs-container` 里，这里不改、不遮、不隐藏；
 *   - 键盘用 diagram-js 15 的实际行为（内部绑 canvas SVG），**不调用
 *     `keyboard.bindTo(document)`**，避免和宿主全局快捷键抢键；
 *   - 实例视图使用 NavigatedViewer（无 modeling / palette / 属性面板），只读；
 *   - 主题切换只改 CSS：不通过 modeling 改 BPMN DI、不制造 dirty、不污染撤销栈。
 *
 * @module @feiyueve/dsh-flow-studio/client/bpmn/editor
 */

import Modeler from 'bpmn-js/lib/Modeler.js'
import NavigatedViewer from 'bpmn-js/lib/NavigatedViewer.js'

import {
  BpmnPropertiesPanelModule,
  BpmnPropertiesProviderModule,
} from 'bpmn-js-properties-panel'

import zeebeModdlePackage from '../../zeebe-moddle-vendor.js'
import { createFsModdlePackage } from '../../bpmn-moddle.js'

import { FsCreateBehaviorModule } from './behavior.js'
import { FsContextPadModule } from './context-pad.js'
import { FsPaletteModule } from './palette.js'
import { FsPropertiesProviderModule } from './properties-provider.js'
import { FsReplaceModule } from './replace.js'
import { FsRulesModule } from './rules.js'
import { ensureEditorStyle, releaseEditorStyle } from './styles.js'

/** 运行态 marker 的合法状态（其余按 failed 处理，避免静默）。 */
const RUNTIME_STATES = new Set(['active', 'waiting', 'completed', 'failed', 'canceled'])
const MARKER_PREFIX = 'fs-runtime-'

/** 每次拿一份新描述符：bpmn-moddle 构造时会就地给类型加前缀。 */
function cloneModdlePackage(pkg) {
  return JSON.parse(JSON.stringify(pkg))
}

function normalizeRuntimeState(state) {
  const text = typeof state === 'string' ? state.trim().toLowerCase() : ''
  return RUNTIME_STATES.has(text) ? text : 'failed'
}

/**
 * 在宿主提供的容器里挂载 BPMN 编辑器。
 *
 * @param {HTMLElement} container
 * @param {object} [options]
 * @param {string} [options.xml] 初始 BPMN XML；缺省时用 Modeler.createDiagram()
 * @param {'modeler'|'viewer'} [options.mode='modeler']
 * @param {Function} [options.onChange] 编辑变更回调（`{dirty, mode}`）；导入/主题/运行态不触发
 * @param {Function} [options.onError]
 * @param {Array<{elementId: string, state: string}>} [options.runtimeMarkers]
 * @returns {object} 命令式控制器（含 ready / importXML / saveXML / setViewerMode / setRuntimeState / destroy）
 */
export function mountEditor(container, options = {}) {
  if (!container || typeof container.appendChild !== 'function') {
    throw new TypeError('mountEditor(container) 需要一个可挂载的 DOM 容器')
  }
  const doc = container.ownerDocument
  if (!doc || typeof doc.createElement !== 'function') {
    throw new Error('mountEditor 需要 DOM 环境（chunk 只能在浏览器里挂载）')
  }

  const wrapper = doc.createElement('div')
  wrapper.className = 'fs-bpmn-editor'
  wrapper.setAttribute('data-fs-bpmn-editor', '')
  const main = doc.createElement('div')
  main.className = 'fs-bpmn-editor-main'
  const canvasEl = doc.createElement('div')
  canvasEl.className = 'fs-bpmn-editor-canvas'
  canvasEl.setAttribute('data-fs-bpmn-canvas', '')
  const propertiesEl = doc.createElement('div')
  propertiesEl.className = 'fs-bpmn-editor-properties'
  propertiesEl.setAttribute('data-fs-bpmn-properties', '')
  main.appendChild(canvasEl)
  main.appendChild(propertiesEl)
  wrapper.appendChild(main)
  container.appendChild(wrapper)

  ensureEditorStyle(doc)

  /**
   * 面板内编辑控件不触发图操作。
   *
   * 官方 properties-panel 会在面板容器上直接绑 Ctrl+Z / Ctrl+Y → commandStack.undo/redo
   * （不管事件目标是 input / textarea）。0.13.3 要求“输入框、属性面板、弹窗内不触发图
   * 操作”，所以在 capture 阶段拦下可编辑控件里的撤销/重做快捷键：不 preventDefault，
   * 输入框自己的原生文本撤销照常工作，只是不再冒泡到面板的图撤销处理。
   */
  const guardPanelKeyboard = event => {
    const target = event && event.target
    if (!target || typeof target.closest !== 'function') return
    if (!target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) return
    if (!(event.ctrlKey || event.metaKey)) return
    if (!/^[zy]$/i.test(event.key || '')) return
    event.stopPropagation()
  }
  propertiesEl.addEventListener('keydown', guardPanelKeyboard, true)

  let disposed = false
  let instance = null
  let isViewer = options.mode === 'viewer'
  let currentXml = typeof options.xml === 'string' && options.xml.trim() !== '' ? options.xml : null
  let dirty = false
  let suppressChange = false
  let runtimeMarkers = Array.isArray(options.runtimeMarkers) ? options.runtimeMarkers.slice() : []
  const appliedMarkers = new Map()

  const onChange = typeof options.onChange === 'function' ? options.onChange : null
  const onError = typeof options.onError === 'function' ? options.onError : null

  if (isViewer) wrapper.classList.add('fs-bpmn-editor-viewer')

  const moddleExtensions = () => ({
    fs: createFsModdlePackage(),
    zeebe: cloneModdlePackage(zeebeModdlePackage),
  })

  function buildModeler() {
    return new Modeler({
      container: canvasEl,
      propertiesPanel: { parent: propertiesEl },
      additionalModules: [
        BpmnPropertiesPanelModule,
        BpmnPropertiesProviderModule,
        FsPropertiesProviderModule,
        FsPaletteModule,
        FsContextPadModule,
        FsReplaceModule,
        FsRulesModule,
        FsCreateBehaviorModule,
      ],
      moddleExtensions: moddleExtensions(),
      keyboard: { bind: true },
    })
  }

  function buildViewer() {
    return new NavigatedViewer({
      container: canvasEl,
      moddleExtensions: moddleExtensions(),
      keyboard: { bind: true },
    })
  }

  function handleCommandChanged() {
    if (suppressChange) return
    dirty = true
    if (onChange) {
      try {
        onChange({ dirty: true, mode: isViewer ? 'viewer' : 'modeler' })
      } catch {
        // 宿主回调抛错不能把画布带崩
      }
    }
  }

  function attachListeners(target) {
    const eventBus = target.get('eventBus')
    if (eventBus) eventBus.on('commandStack.changed', handleCommandChanged)
  }

  function resetHistory() {
    if (isViewer || !instance) return
    const commandStack = instance.get('commandStack')
    if (!commandStack) return
    suppressChange = true
    try {
      commandStack.clear()
    } finally {
      suppressChange = false
    }
    dirty = false
  }

  function fitViewport() {
    if (!instance) return
    try {
      instance.get('canvas').zoom('fit-viewport', 'auto')
    } catch {
      // 空图/极窄容器下 fit 可能失败，不影响可用性
    }
  }

  function clearRuntimeMarkers() {
    if (!instance) return
    let canvas
    try {
      canvas = instance.get('canvas', false)
    } catch {
      canvas = null
    }
    if (!canvas) return
    for (const [elementId, className] of appliedMarkers) {
      try {
        canvas.removeMarker(elementId, className)
      } catch {
        // 元素可能已删除
      }
    }
    appliedMarkers.clear()
  }

  function applyRuntimeMarkers() {
    if (!instance) return
    let canvas
    try {
      canvas = instance.get('canvas', false)
    } catch {
      canvas = null
    }
    if (!canvas) return
    clearRuntimeMarkers()
    for (const item of runtimeMarkers) {
      if (!item || typeof item.elementId !== 'string' || item.elementId === '') continue
      const className = `${MARKER_PREFIX}${normalizeRuntimeState(item.state)}`
      try {
        canvas.addMarker(item.elementId, className)
        appliedMarkers.set(item.elementId, className)
      } catch {
        // 事件里带的是执行实例 activityId 时可能对不上图元：忽略，不写 XML
      }
    }
  }

  async function serialize(extra = {}) {
    if (!instance) throw new Error('BPMN 画布尚未创建')
    if (isViewer) return currentXml || ''
    const result = await instance.saveXML({ format: true, ...extra })
    const xml = typeof result === 'string' ? result : (result && result.xml) || ''
    if (xml) currentXml = xml
    return xml
  }

  async function loadXml(xml) {
    const next = String(xml)
    if (!instance) {
      currentXml = next
      return
    }
    const previous = currentXml
    try {
      await instance.importXML(next)
    } catch (error) {
      // 导入失败时保留旧快照引用，页面可以继续展示/重试，不会被坏 XML 覆盖。
      currentXml = previous
      throw error
    }
    currentXml = next
    resetHistory()
    fitViewport()
    applyRuntimeMarkers()
  }

  async function importXML(xml) {
    if (disposed) throw new Error('BPMN 画布已销毁')
    if (typeof xml !== 'string' || xml.trim() === '') {
      throw new TypeError('importXML(xml) 需要非空 BPMN XML 字符串')
    }
    await loadXml(xml)
    return { ok: true }
  }

  async function saveXML(extra = {}) {
    if (disposed) throw new Error('BPMN 画布已销毁')
    return serialize(extra)
  }

  function destroyInstance() {
    clearRuntimeMarkers()
    if (!instance) return
    const target = instance
    instance = null
    try {
      target.destroy()
    } catch {
      // 销毁失败不阻断卸载
    }
    while (canvasEl.firstChild) canvasEl.removeChild(canvasEl.firstChild)
  }

  async function createInstance() {
    destroyInstance()
    instance = isViewer ? buildViewer() : buildModeler()
    attachListeners(instance)
    wrapper.classList.toggle('fs-bpmn-editor-viewer', isViewer)
    propertiesEl.hidden = isViewer
    if (isViewer) {
      propsElClear()
    }
    return instance
  }

  /** Viewer 没有属性面板模块，清掉可能残留的面板 DOM。 */
  function propsElClear() {
    while (propertiesEl.firstChild) propertiesEl.removeChild(propertiesEl.firstChild)
  }

  async function setViewerMode(enabled) {
    if (disposed) throw new Error('BPMN 画布已销毁')
    const next = Boolean(enabled)
    if (next === isViewer) return { ok: true, mode: isViewer ? 'viewer' : 'modeler' }
    if (!isViewer) {
      try {
        await serialize()
      } catch {
        // 空图还没有定义时保持已有 currentXml/undefined
      }
    }
    isViewer = next
    await createInstance()
    if (currentXml) {
      await instance.importXML(currentXml)
    } else if (!isViewer) {
      await instance.createDiagram()
      currentXml = await serialize()
    }
    resetHistory()
    fitViewport()
    applyRuntimeMarkers()
    return { ok: true, mode: isViewer ? 'viewer' : 'modeler' }
  }

  function setRuntimeState(markers) {
    runtimeMarkers = Array.isArray(markers) ? markers.slice() : []
    if (instance) applyRuntimeMarkers()
    return { ok: true, count: runtimeMarkers.length }
  }

  function destroy() {
    if (disposed) return
    disposed = true
    propertiesEl.removeEventListener('keydown', guardPanelKeyboard, true)
    destroyInstance()
    if (wrapper.parentNode) wrapper.parentNode.removeChild(wrapper)
    releaseEditorStyle(doc)
  }

  const controller = {
    version: '0.13.3-phase4',
    ready: null,
    getModeler() {
      return instance
    },
    getMode() {
      return isViewer ? 'viewer' : 'modeler'
    },
    isDirty() {
      return dirty
    },
    isDestroyed() {
      return disposed
    },
    getContainer() {
      return wrapper
    },
    importXML,
    saveXML,
    setViewerMode,
    setRuntimeState,
    destroy,
  }

  controller.ready = (async () => {
    try {
      await createInstance()
      if (currentXml) {
        await instance.importXML(currentXml)
      } else if (!isViewer) {
        await instance.createDiagram()
        currentXml = await serialize()
      }
      resetHistory()
      fitViewport()
      applyRuntimeMarkers()
      dirty = false
      if (onChange) onChange({ dirty: false, mode: isViewer ? 'viewer' : 'modeler' })
      return { ok: true, mode: isViewer ? 'viewer' : 'modeler' }
    } catch (error) {
      if (onError) {
        try {
          onError(error)
        } catch {
          // 宿主回调抛错不吞掉原始错误信息
        }
      }
      return { ok: false, error }
    }
  })()

  if (disposed) {
    // 极端情况：调用方在 ready 之前 destroy
    destroy()
  }

  return controller
}
