/**
 * 浏览器端共享运行时。
 *
 * React 由宿主的模块表提供（factory 的 require('react')），但组件模块在打包时是
 * 顶层求值的，拿不到 factory 的局部变量 —— 所以集中在这里注入一次，别处只读 rt。
 *
 * @module @feiyueve/dsh-flow-studio/client/runtime
 */

/** 注入后的 React 句柄；组件里用 `const { useState } = rt.React` 取钩子。 */
export const rt = { React: null, h: null }

/** 由 plugin.js 在 factory 内调用，早于任何组件渲染。 */
export function bindReact(React) {
  rt.React = React
  rt.h = React.createElement
}

/** createElement 的短名，省掉每行 rt.h。 */
export function h(type, props, ...children) {
  return rt.h(type, props, ...children)
}

/** 合并 className（丢弃假值）。 */
export function cx(...parts) {
  return parts.filter(Boolean).join(' ')
}

/** 把节点固定尺寸换算成矩形，画布与命中测试共用。 */
export function rectOf(node, width, height) {
  return { x: node.x, y: node.y, w: width, h: height }
}

/** 数值夹取。 */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}
