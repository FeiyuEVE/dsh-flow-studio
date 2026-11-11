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
  // 生命周期世代：每次 destroy +1。所有 await 之后都必须校验，
  // 防止「导入/重建进行中编辑器被销毁」时继续操作已清空的实例（复审 M5）。
  let lifecycle = 0
  // 回滚重建失败后的显式不可用原因；再次导入必须先真正重建实例。
  let unavailableReason = ''
  let instance = null
  let isViewer = options.mode === 'viewer'
  let currentXml = typeof options.xml === 'string' && options.xml.trim() !== '' ? options.xml : null
  let dirty = false
  let suppressChange = false
  let runtimeMarkers = Array.isArray(options.runtimeMarkers) ? options.runtimeMarkers.slice() : []
  const appliedMarkers = new Map()

  const onChange = typeof options.onChange === 'function' ? options.onChange : null
  const onError = typeof options.onError === 'function' ? options.onError : null

  function destroyedError() {
    return new Error('BPMN 画布已销毁')
  }

  function failureMessage(error) {
    if (!error) return '未知原因'
    if (typeof error === 'string') return error
    if (typeof error.message === 'string' && error.message !== '') return error.message
    return String(error)
  }

  /** 异步边界统一校验：销毁或世代变化后禁止再触碰 instance / 回滚重建。 */
  function assertAlive(generation) {
    if (disposed || generation !== lifecycle) throw destroyedError()
  }

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
    // 销毁后旧 Modeler 若还活着，它的 commandStack 事件也不能再回调宿主。
    if (disposed || suppressChange) return
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
    if (!instance) {
      if (unavailableReason !== '') throw new Error('BPMN 画布不可用（恢复失败）：' + unavailableReason)
      throw new Error('BPMN 画布尚未创建')
    }
    if (isViewer) return currentXml || ''
    const result = await instance.saveXML({ format: true, ...extra })
    const xml = typeof result === 'string' ? result : (result && result.xml) || ''
    if (xml) currentXml = xml
    return xml
  }

  /**
   * 用当前 moddle 预检 XML：bpmn-js 会先把新 definitions 装进 Modeler，再在绘制
   * 阶段因缺少 BPMN DI 抛错；预检把这类失败挡在替换当前模型之前。
   */
  async function assertImportable(xml, generation) {
    assertAlive(generation)
    const target = instance
    if (!target) throw destroyedError()
    const moddle = target.get('moddle', false)
    if (!moddle || typeof moddle.fromXML !== 'function') return
    const parsed = await moddle.fromXML(xml)
    // await 期间可能已被 destroy：绝不能用已清空的实例继续导入。
    assertAlive(generation)
    const definitions = parsed && (parsed.rootElement || parsed)
    const diagrams = definitions && Array.isArray(definitions.diagrams) ? definitions.diagrams : []
    if (diagrams.length === 0) throw new Error('no diagram to display')
  }

  /**
   * 导入失败后的完整回滚：从旧 XML 重建 Modeler/Viewer，连同 definitions、DI、
   * 属性面板与撤销栈一起恢复，避免只恢复字符串、模型却停在新定义的空壳里。
   *
   * 重建失败时销毁半成品并抛出原因，由 `loadXml` 把编辑器标记为不可用；
   * document 已销毁则直接中止，禁止「销毁后回滚又造出一个无法销毁的 Modeler」。
   */
  async function restoreModel(previousXml, previousDirty, generation) {
    assertAlive(generation)
    const wasSuppressed = suppressChange
    suppressChange = true
    try {
      destroyInstance()
      assertAlive(generation)
      await createInstance(generation)
      assertAlive(generation)
      if (previousXml) {
        await instance.importXML(previousXml)
      } else if (!isViewer) {
        await instance.createDiagram()
      }
      assertAlive(generation)
      resetHistory()
      dirty = previousDirty
      fitViewport()
      applyRuntimeMarkers()
    } catch (error) {
      // 重建失败：不能留下半成品实例，也不能让后续 loadXml 把 XML 当缓存静默成功。
      destroyInstance()
      throw error
    } finally {
      suppressChange = wasSuppressed
    }
  }

  async function loadXml(xml, generation) {
    const next = String(xml)
    assertAlive(generation)
    if (!instance) {
      // 只有回滚重建失败 / 尚未 ready 才会走到这里：必须真正重新创建实例，
      // 不能把 XML 写进 currentXml 就当成功（复审 M6）。
      await createInstance(generation)
      assertAlive(generation)
    }
    const previous = currentXml
    const previousDirty = dirty
    // 先独立解析并检查 DI，再触碰当前实例；无 DI 的合法 XML 会在这里被拒绝。
    await assertImportable(next, generation)
    assertAlive(generation)
    try {
      await instance.importXML(next)
    } catch (error) {
      // 销毁是取消这次导入，不是导入失败：不许回滚重建。
      if (disposed || generation !== lifecycle) throw destroyedError()
      // bpmn-js 在绘制失败前可能已经替换 _definitions：重建整个实例恢复旧模型。
      currentXml = previous
      try {
        await restoreModel(previous, previousDirty, generation)
      } catch (restoreError) {
        if (disposed || generation !== lifecycle) throw destroyedError()
        unavailableReason = failureMessage(restoreError)
        if (error && typeof error === 'object') error.restoreError = restoreError
      }
      throw error
    }
    // importXML 期间被销毁：模型已经不是这台编辑器的，不能再确认成功。
    assertAlive(generation)
    currentXml = next
    unavailableReason = ''
    resetHistory()
    fitViewport()
    applyRuntimeMarkers()
  }

  async function importXML(xml) {
    if (disposed) throw new Error('BPMN 画布已销毁')
    if (typeof xml !== 'string' || xml.trim() === '') {
      throw new TypeError('importXML(xml) 需要非空 BPMN XML 字符串')
    }
    const generation = lifecycle
    try {
      await loadXml(xml, generation)
    } catch (error) {
      // 被销毁时不把「实例已清空」之类的内部错误抛给宿主。
      if (disposed || generation !== lifecycle) throw destroyedError()
      throw error
    }
    return { ok: true }
  }

  async function saveXML(extra = {}) {
    if (disposed) throw new Error('BPMN 画布已销毁')
    return serialize(extra)
  }

  function destroyInstance() {
    clearRuntimeMarkers()
    const target = instance
    instance = null
    if (target) {
      try {
        target.destroy()
      } catch {
        // 销毁失败不阻断卸载
      }
    }
    // 构造失败可能留下部分 DOM：即使 instance 为空也要清干净画布容器。
    while (canvasEl.firstChild) canvasEl.removeChild(canvasEl.firstChild)
  }

  async function createInstance(generation = lifecycle) {
    assertAlive(generation)
    destroyInstance()
    assertAlive(generation)
    let built = null
    try {
      built = isViewer ? buildViewer() : buildModeler()
      // 构造是同步的，但保留边界检查：销毁后不能把模型挂到已卸载的容器上。
      if (disposed || generation !== lifecycle) throw destroyedError()
      instance = built
      attachListeners(instance)
      wrapper.classList.toggle('fs-bpmn-editor-viewer', isViewer)
      propertiesEl.hidden = isViewer
      if (isViewer) {
        propsElClear()
      }
      return instance
    } catch (error) {
      if (built) {
        try {
          built.destroy()
        } catch {
          // 构造半成品销毁失败不阻断
        }
      }
      instance = null
      // 构造失败可能已经往画布容器里加了节点：清理掉再抛错。
      while (canvasEl.firstChild) canvasEl.removeChild(canvasEl.firstChild)
      if (!disposed && generation === lifecycle) unavailableReason = failureMessage(error)
      throw error
    }
  }

  /** Viewer 没有属性面板模块，清掉可能残留的面板 DOM。 */
  function propsElClear() {
    while (propertiesEl.firstChild) propertiesEl.removeChild(propertiesEl.firstChild)
  }

  async function setViewerMode(enabled) {
    if (disposed) throw new Error('BPMN 画布已销毁')
    const generation = lifecycle
    const next = Boolean(enabled)
    // 模式相同且实例还在：无需重建；实例已经被销毁 / 恢复失败时必须重建。
    if (next === isViewer && instance) return { ok: true, mode: isViewer ? 'viewer' : 'modeler' }
    if (!isViewer) {
      try {
        await serialize()
      } catch {
        // 空图还没有定义时保持已有 currentXml/undefined
      }
      assertAlive(generation)
    }
    isViewer = next
    await createInstance(generation)
    assertAlive(generation)
    if (currentXml) {
      await instance.importXML(currentXml)
    } else if (!isViewer) {
      await instance.createDiagram()
      currentXml = await serialize()
    }
    assertAlive(generation)
    unavailableReason = ''
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

  /**
   * 保存前把属性面板里未提交的输入落进模型：
   *   - 关闭官方弹出编辑器（弹窗挂在 document.body，不在本编辑器容器内）；
   *   - 关闭时官方 TextArea 会 flush 去抖输入。
   * 容器内普通控件的 blur 仍由页面 `commitPendingProperties` 的焦点处理负责，
   * 这里不抢先 blur，避免把需要等去抖窗的 contenteditable 路径截断。
   */
  async function flushProperties() {
    if (disposed || !instance || isViewer) return { ok: false, popupClosed: false }
    let popupClosed = false
    try {
      const popup = instance.get('feelPopup', false)
      popupClosed = Boolean(popup && typeof popup.isOpen === 'function' && popup.isOpen())
      const eventBus = instance.get('eventBus', false)
      if (eventBus) eventBus.fire('propertiesPanel.closePopup')
      else if (popup && typeof popup.close === 'function') popup.close()
    } catch {
      // 关闭弹窗失败不阻断保存：模型里仍是上一次已提交值。
    }
    // 让 preact 的命令栈/受控组件回调先跑完。
    await Promise.resolve()
    return { ok: true, popupClosed }
  }

  function destroy() {
    if (disposed) return
    disposed = true
    // 先推进世代：任何在飞导入 / 回滚重建都会在下一个 await 边界中止。
    lifecycle += 1
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
    /** 回滚重建失败后的不可用原因；空串 = 可用。 */
    getUnavailableReason() {
      return unavailableReason
    },
    getContainer() {
      return wrapper
    },
    importXML,
    saveXML,
    flushProperties,
    setViewerMode,
    setRuntimeState,
    destroy,
  }

  controller.ready = (async () => {
    const generation = lifecycle
    try {
      await createInstance(generation)
      assertAlive(generation)
      if (currentXml) {
        await instance.importXML(currentXml)
      } else if (!isViewer) {
        await instance.createDiagram()
        currentXml = await serialize()
      }
      assertAlive(generation)
      resetHistory()
      fitViewport()
      applyRuntimeMarkers()
      unavailableReason = ''
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
