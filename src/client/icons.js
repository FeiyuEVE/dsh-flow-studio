/**
 * 图标：侧栏入口 + 面板内小图标。全部内联 SVG，不依赖图标字体或外部资源。
 *
 * @module @feiyueve/dsh-flow-studio/client/icons
 */

import { h } from './runtime.js'

/**
 * 侧栏入口图标：三个节点 + 连线，一眼看出是「编排」。
 * owner props 只有 size / active。
 */
export function StudioIcon({ size = 18, active = false }) {
  const color = active ? 'var(--dsw-alias-brand-primary)' : 'currentColor'
  return h('svg', {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    'aria-hidden': true,
    style: { display: 'block' },
  },
  h('rect', { x: 2.2, y: 3.2, width: 7.2, height: 5.6, rx: 1.6, stroke: color, strokeWidth: 1.5 }),
  h('rect', { x: 2.2, y: 15.2, width: 7.2, height: 5.6, rx: 1.6, stroke: color, strokeWidth: 1.5 }),
  h('rect', { x: 14.6, y: 9.2, width: 7.2, height: 5.6, rx: 1.6, stroke: color, strokeWidth: 1.5 }),
  h('path', { d: 'M9.4 6h2.4a1.6 1.6 0 0 1 1.6 1.6v3', stroke: color, strokeWidth: 1.5, strokeLinecap: 'round' }),
  h('path', { d: 'M9.4 18h2.4a1.6 1.6 0 0 0 1.6-1.6v-3', stroke: color, strokeWidth: 1.5, strokeLinecap: 'round' }),
  )
}

/** 小图标：加号。 */
export function PlusIcon({ size = 13 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, style: { display: 'block' } },
    h('path', { d: 'M8 3v10M3 8h10', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }))
}

/** 小图标：叉。 */
export function CloseIcon({ size = 12 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, style: { display: 'block' } },
    h('path', { d: 'M4 4l8 8M12 4l-8 8', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }))
}
