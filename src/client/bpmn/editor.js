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

  // ── 写操作串行化（复审 F2）──────────────────────────────────────────────
  // 两次并发 `importXML` 会各自修改**同一个真实模型**：先挂起的旧导入释放后
  // 会把新导入的 definitions 覆盖掉，页面再比对世代也只能丢弃返回值，改不回模型。
  // 因此所有会写模型的操作（模式切换 + 导入）排进同一条队列，并用单调 token
  // 标记「最新请求」：旧操作在触碰模型之前发现 token 过期就直接作废。
  let operationChain = Promise.resolve()
  let latestOperationToken = 0

  function nextOperationToken() {
    latestOperationToken += 1
    return latestOperationToken
  }

  /** 外部（页面视图世代）传入的 token 只允许把「最新请求」往前推。 */
  function noteOperationToken(token) {
    if (Number.isSafeInteger(token) && token > latestOperationToken) latestOperationToken = token
    return Number.isSafeInteger(token) ? token : nextOperationToken()
  }

  function staleResult() {
    return { ok: false, stale: true, reason: '画布操作已被更新的请求取代' }
  }

  function isStale(token) {
    return Number.isSafeInteger(token) && token < latestOperationToken
  }

  function enqueueOperation(task) {
    const run = operationChain.then(() => task())
    // 一个失败的操作不能把后面的操作卡死：错误只交给本次调用方。
    operationChain = run.then(() => undefined, () => undefined)
    return run
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

  async function serialize(extra = {}, generation = lifecycle) {
    // 生命周期检查要覆盖 await 之后（复审 f2）：销毁后再序列化成功，
    // 等于向宿主确认一个已经被清空的模型仍然可保存。
    assertAlive(generation)
    if (!instance) {
      if (unavailableReason !== '') throw new Error('BPMN 画布不可用（恢复失败）：' + unavailableReason)
      throw new Error('BPMN 画布尚未创建')
    }
    if (isViewer) return currentXml || ''
    const result = await instance.saveXML({ format: true, ...extra })
    assertAlive(generation)
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

  /**
   * 把一份 XML 导入当前实例。
   *
   * `token` 是写操作世代：一旦被更新的请求超越，就在**触碰模型之前**返回 stale，
   * 而不是先改模型再让调用方丢弃返回值（复审 F2）。已经开始的 `importXML` 会
   * 跑完（不能半途拆模型），但随后排队的最新请求会覆盖它。
   *
   * @returns {Promise<{ok: boolean, stale?: boolean}>}
   */
  async function loadXml(xml, generation, token) {
    const next = String(xml)
    assertAlive(generation)
    if (isStale(token)) return { ok: false, stale: true }
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
    // 预检期间可能有更新的视图请求：此刻放弃还来得及保住当前模型。
    if (isStale(token)) return { ok: false, stale: true }
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
    // 导入已经真实发生：缓存必须跟着模型走（即使本次结果因过期被丢弃）。
    currentXml = next
    unavailableReason = ''
    resetHistory()
    fitViewport()
    applyRuntimeMarkers()
    if (isStale(token)) return { ok: false, stale: true }
    return { ok: true }
  }

  async function importXML(xml) {
    if (disposed) throw new Error('BPMN 画布已销毁')
    if (typeof xml !== 'string' || xml.trim() === '') {
      throw new TypeError('importXML(xml) 需要非空 BPMN XML 字符串')
    }
    const token = nextOperationToken()
    return enqueueOperation(async () => {
      if (disposed) throw destroyedError()
      const generation = lifecycle
      try {
        const result = await loadXml(xml, generation, token)
        if (result && result.stale) return staleResult()
        return { ok: true }
      } catch (error) {
        // 被销毁时不把「实例已清空」之类的内部错误抛给宿主。
        if (disposed || generation !== lifecycle) throw destroyedError()
        throw error
      }
    })
  }

  async function saveXML(extra = {}) {
    if (disposed) throw new Error('BPMN 画布已销毁')
    // f2：serialize 内部在底层 saveXML 的 await 之后校验生命周期，
    // 已销毁的控制器不能返回「保存成功」。
    return serialize(extra, lifecycle)
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

  /**
   * 切换 Modeler / NavigatedViewer。
   *
   * 串行执行，并带写操作 token；失败时**销毁半成品实例并记录不可用原因**
   * （复审 F3）：否则一个没绘制出图、也没装载 definitions 的实例会继续存在，
   * 再次调用同一模式还会因为 `next === isViewer && instance` 直接返回假成功。
   *
   * @returns {Promise<{ok: boolean, mode: string, stale?: boolean}>}
   */
  async function switchMode(enabled, token) {
    assertAlive(lifecycle)
    const generation = lifecycle
    const next = Boolean(enabled)
    const modeText = () => (isViewer ? 'viewer' : 'modeler')
    if (isStale(token)) return { ...staleResult(), mode: modeText() }
    // 模式相同且实例还在：无需重建；实例已经被销毁 / 恢复失败时必须重建。
    if (next === isViewer && instance && unavailableReason === '') {
      return { ok: true, mode: modeText() }
    }
    if (!isViewer) {
      try {
        await serialize(undefined, generation)
      } catch {
        // 空图还没有定义时保持已有 currentXml/undefined
      }
      assertAlive(generation)
      if (isStale(token)) return { ...staleResult(), mode: modeText() }
    }
    isViewer = next
    try {
      await createInstance(generation)
      assertAlive(generation)
      if (currentXml) {
        await instance.importXML(currentXml)
      } else if (!isViewer) {
        await instance.createDiagram()
        assertAlive(generation)
        currentXml = await serialize(undefined, generation)
      }
      assertAlive(generation)
    } catch (error) {
      // 模式切换失败：不能留下半成品实例，也不能让后续调用误以为画布可用。
      destroyInstance()
      if (!disposed && generation === lifecycle) unavailableReason = failureMessage(error)
      throw error
    }
    unavailableReason = ''
    resetHistory()
    fitViewport()
    applyRuntimeMarkers()
    if (isStale(token)) return { ...staleResult(), mode: modeText() }
    return { ok: true, mode: modeText() }
  }

  async function setViewerMode(enabled) {
    if (disposed) throw new Error('BPMN 画布已销毁')
    const token = nextOperationToken()
    return enqueueOperation(() => switchMode(enabled, token))
  }

  /**
   * 原子地提交一次「模式 + XML」视图（页面视图世代作为 token）。
   *
   * 模式切换和导入在同一个队列任务里完成，避免两次视图请求在
   * `setViewerMode` / `importXML` 两个 await 之间交错：旧请求的模式切换
   * 可能排到新请求的导入之后，把新模型又覆盖回旧模型（复审 F2）。
   */
  async function applyView(options = {}) {
    if (disposed) throw new Error('BPMN 画布已销毁')
    const xml = typeof options.xml === 'string' ? options.xml : ''
    const token = noteOperationToken(options.token)
    const viewer = options.viewer === true
    return enqueueOperation(async () => {
      if (disposed) throw destroyedError()
      const generation = lifecycle
      if (isStale(token)) return staleResult()
      const switched = await switchMode(viewer, token)
      assertAlive(generation)
      if (switched && switched.stale) return staleResult()
      if (xml.trim() !== '') {
        const imported = await loadXml(xml, generation, token)
        assertAlive(generation)
        if (imported && imported.stale) return staleResult()
      }
      return { ok: true, mode: isViewer ? 'viewer' : 'modeler' }
    })
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
    const generation = lifecycle
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
    // f2：最后一个 await 之后仍要确认控制器没有被销毁，否则已销毁的编辑器
    // 会把「属性已提交」这个结论错误地交给保存流程。
    assertAlive(generation)
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
    applyView,
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
