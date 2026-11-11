/**
 * BPMN 画布宿主壳（SSR 安全）。
 *
 * 三条边界：
 *  1. 顶层不 import bpmn-js / diagram-js，也不碰 `document` / `window` —— 服务端渲染
 *     （test/render.test.mjs）与裸 Node import（test/client-perf.test.mjs）都只求值本文件；
 *  2. 真实编辑器在 `lib/client.bpmn.js`（宿主 chunk），只在 `useEffect` 里通过宿主
 *     `require.async('./client.bpmn.js')` 加载。必须是**相对 chunk 名**：宿主只有
 *     `./` 分支会进入 importChunk()；
 *  3. SSR 输出稳定的结构（标题 / 状态 / 加载提示 / 失败重试），加载失败不白屏。
 *
 * 生命周期由世代编号（generation）兜底：关闭、重试、切换画布都会让旧异步结果失效，
 * 防止「已经卸载了还把 Modeler 创建出来」。chunk 未加载成功前不创建任何实例。
 *
 * @module @feiyueve/dsh-flow-studio/client/canvas
 */

import { cx, h, rt } from './runtime.js'

/** 宿主 chunk 的相对请求名（宿主协议要求带 `./` 前缀）。 */
export const BPMN_CHUNK = './client.bpmn.js'
/** 宿主协议里的固定 chunk 文件名（注册字段与请求 URL 都用它）。 */
export const BPMN_CHUNK_FILE = 'client.bpmn.js'

/**
 * 画布壳状态 → 可读文案。纯函数，SSR 与测试共用。
 * @param {'loading'|'ready'|'error'} status
 * @returns {string}
 */
export function canvasStatusText(status) {
  if (status === 'ready') return 'BPMN 画布已加载'
  if (status === 'error') return 'BPMN 画布加载失败'
  return 'BPMN 画布加载中…'
}

/** 世代编号只增不减；异步结果与当前值不等即视为过期。 */
export function nextCanvasGeneration(current) {
  return (Number.isFinite(current) ? current : 0) + 1
}

/**
 * 画布壳组件。
 *
 * props:
 * - `title`：标题（默认「流程画布」）；
 * - `hostRequire`：可选，覆盖运行时注入的宿主 require（测试用；默认读 rt.require）；
 * - `mountOptions`：透传给 chunk 的 `mountEditor(container, options)`；
 * - `onReady(mod)` / `onError(error)`：加载结果回调；
 * - `className` / `ariaLabel`：外壳样式与可读名。
 *
 * @param {object} props
 */
export function BpmnCanvas(props = {}) {
  const React = rt.React
  if (!React) throw new Error('BpmnCanvas 需要先由宿主注入 React（bindReact）')
  const { useCallback, useEffect, useRef, useState } = React

  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState({ status: 'loading', error: null, version: null })
  const mountRef = useRef(null)
  const editorRef = useRef(null)
  const generationRef = useRef(0)
  // 渲染期把最新 props 记进 ref，effect 只依赖 attempt：父组件内联对象不会导致重复加载。
  const latestRef = useRef({})
  latestRef.current = {
    hostRequire: props.hostRequire,
    mountOptions: props.mountOptions,
    onReady: props.onReady,
    onError: props.onError,
  }

  useEffect(() => {
    const generation = nextCanvasGeneration(generationRef.current)
    generationRef.current = generation
    let disposed = false
    const isStale = () => disposed || generation !== generationRef.current

    setState({ status: 'loading', error: null, version: null })

    const latest = latestRef.current
    const hostRequire = latest.hostRequire ?? rt.require
    if (!hostRequire || typeof hostRequire.async !== 'function') {
      setState({
        status: 'error',
        error: '宿主未提供模块加载器（require.async），无法加载 BPMN 画布。',
        version: null,
      })
      return () => {
        disposed = true
        generationRef.current = nextCanvasGeneration(generationRef.current)
      }
    }

    let pending
    try {
      // 关键：只在 effect 里、用相对 chunk 名发起异步加载；SSR 不执行到这里。
      pending = hostRequire.async(BPMN_CHUNK)
    } catch (error) {
      pending = Promise.reject(error)
    }

    Promise.resolve(pending)
      .then(chunk => {
        if (isStale()) return
        if (!chunk || (typeof chunk.version !== 'string' && typeof chunk.mountEditor !== 'function')) {
          throw new Error('BPMN 画布 chunk 导出无效（缺 version / mountEditor）。')
        }
        let editor = null
        if (typeof chunk.mountEditor === 'function' && mountRef.current) {
          editor = chunk.mountEditor(mountRef.current, {
            ...(latest.mountOptions || {}),
            hostRequire,
          })
        }
        if (isStale()) {
          if (editor && typeof editor.destroy === 'function') {
            try { editor.destroy() } catch { /* 卸载期销毁失败不阻断 */ }
          }
          return
        }
        editorRef.current = editor
        setState({ status: 'ready', error: null, version: chunk.version ?? null })
        // 第二个参数是 chunk 的命令式控制器（importXML / saveXML / setViewerMode /
        // setRuntimeState / destroy）；步骤 5 的页面用它保存/切换实例只读视图。
        if (typeof latest.onReady === 'function') latest.onReady(chunk, editor)
      })
      .catch(error => {
        if (isStale()) return
        const message = error && error.message ? error.message : String(error)
        setState({ status: 'error', error: message, version: null })
        if (typeof latest.onError === 'function') latest.onError(error)
      })

    return () => {
      disposed = true
      generationRef.current = nextCanvasGeneration(generationRef.current)
      const editor = editorRef.current
      editorRef.current = null
      if (editor && typeof editor.destroy === 'function') {
        try { editor.destroy() } catch { /* 卸载期销毁失败不阻断 */ }
      }
    }
  }, [attempt])

  const retry = useCallback(() => {
    setAttempt(current => current + 1)
  }, [])

  const title = props.title || '流程画布'
  const busy = state.status === 'loading'

  return h('div', {
    className: cx('fs-bpmn-canvas', props.className),
    'data-bpmn-canvas': 'shell',
    'data-state': state.status,
    'data-chunk': BPMN_CHUNK_FILE,
    role: 'region',
    'aria-label': props.ariaLabel || `${title}（BPMN 编辑器）`,
    'aria-busy': busy ? 'true' : 'false',
  },
  h('div', { className: 'fs-bpmn-canvas-head' },
    h('strong', { className: 'fs-bpmn-canvas-title' }, title),
    h('span', {
      className: 'fs-bpmn-canvas-status',
      role: 'status',
      'aria-live': 'polite',
    }, canvasStatusText(state.status)),
  ),
  h('div', { className: 'fs-bpmn-canvas-stage' },
    h('div', {
      className: 'fs-bpmn-canvas-mount',
      ref: mountRef,
      'data-bpmn-mount': '',
    }),
    busy
      ? h('p', { className: 'fs-bpmn-canvas-hint' }, '正在加载 BPMN 画布资源…')
      : null,
    state.status === 'error'
      ? h('div', { className: 'fs-bpmn-canvas-error', role: 'alert' },
        h('p', null, state.error),
        h('button', {
          type: 'button',
          className: 'fs-bpmn-canvas-retry',
          onClick: retry,
        }, '重试'),
      )
      : null,
    state.status === 'ready'
      ? h('p', { className: 'fs-bpmn-canvas-hint' },
        state.version ? `BPMN 画布已就绪（chunk ${state.version}）` : 'BPMN 画布已就绪')
      : null,
  ))
}

/** 兼容别名：后续页面按「壳」命名引用时不用再改一次。 */
export const BpmnCanvasShell = BpmnCanvas

/*
 * ---------------------------------------------------------------------------
 * 0.13.3 步骤 2 临时兼容层：旧 React Flow 画布仍被 page.js 与现有测试使用，
 * 实现已移到 ./canvas-flow.js；步骤 5 页面切换到 BPMN 后、步骤 7 随旧画布一起删除。
 * 本文件顶层只做 re-export，不 import bpmn-js，也不在上层求值时访问 document。
 * ---------------------------------------------------------------------------
 */
export {
  FlowCanvas,
  canConnectNodes,
  createDragHandlers,
  createNodeDecorator,
  edgeAriaLabel,
  edgeListText,
  flowComponentTypes,
  guardStructureEdit,
  interactionState,
  isEdgeActive,
  lodText,
  nodeAriaLabel,
  openNodeSession,
  sessionIdOf,
  snapToGridEnabled,
  stateShape,
  studioNextEdgeType,
  studioNodeType,
  studioRejectEdgeType,
  wheelPanDelta,
} from './canvas-flow.js'
