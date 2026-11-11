/**
 * 画布 chunk 的样式：官方 CSS（构建期内联字体）+ 主题桥接 + 宿主壳布局。
 *
 * `BPMN_ASSETS_CSS` 由 `scripts/build-bpmn-assets.mjs` 生成（diagram-js / bpmn-js /
 * bpmn-font / properties-panel 四份 CSS，woff2 已 base64）。这里只追加：
 *   1. `.bio-theme-parent` 上的 `--bio-*` → `--dsw-*` 映射（亮/暗两套）；
 *   2. SVG 的填充/描边/文字颜色（bpmn-js 默认是 white/black 属性，CSS 可覆盖）；
 *   3. 壳（`.fs-bpmn-canvas*`）与编辑器（`.fs-bpmn-editor*`）的布局，含窄窗口降级；
 *   4. 运行态 marker（只改 CSS，不写 BPMN DI / 不碰 commandStack）。
 *
 * 样式节点带 `data-fs-bpmn-style` 标记；引用计数归零即移除，避免插件卸载后残留。
 *
 * @module @feiyueve/dsh-flow-studio/client/bpmn/styles
 */

import { BPMN_ASSETS_CSS } from './assets.generated.js'

const STYLE_ATTR = 'data-fs-bpmn-style'

const THEME_CSS = `
/* ── 宿主壳：加载中 / 失败 / 就绪都是稳定结构 ───────────────────── */
.fs-bpmn-canvas{
  display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;
  background:var(--dsw-alias-bg-base, #fff);color:var(--dsw-alias-label-primary, #1a1a1a);
  font-family:var(--dsw-font-family, system-ui, sans-serif);
}
.fs-bpmn-canvas-head{
  display:flex;align-items:center;gap:8px;flex:none;min-height:36px;padding:0 10px;
  border-bottom:1px solid var(--dsw-alias-border-l1, #d9dbde);
  background:var(--dsw-alias-bg-layer-1, #f5f5f6);
}
.fs-bpmn-canvas-title{font-size:13px;line-height:20px;font-weight:600}
.fs-bpmn-canvas-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary, #777)}
.fs-bpmn-canvas-stage{position:relative;flex:1;min-height:0;min-width:0;display:flex}
.fs-bpmn-canvas-mount{position:relative;flex:1;min-width:0;min-height:0;display:flex}
.fs-bpmn-canvas-hint{
  position:absolute;left:12px;top:8px;z-index:5;margin:0;padding:2px 8px;border-radius:4px;
  font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary, #4a4a4a);
  background:color-mix(in srgb, var(--dsw-alias-bg-base, #fff) 88%, transparent);
  pointer-events:none;
}
.fs-bpmn-canvas[data-state="ready"] .fs-bpmn-canvas-hint{display:none}
.fs-bpmn-canvas-error{
  position:absolute;inset:auto 12px 12px 12px;z-index:6;padding:10px 12px;border-radius:6px;
  border:1px solid var(--dsw-alias-state-error-primary, #d92d20);
  background:var(--dsw-alias-bg-layer-1, #fff);font-size:12px;
}
.fs-bpmn-canvas-error p{margin:0 0 8px}
.fs-bpmn-canvas-retry{
  padding:2px 10px;border-radius:4px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l3, #b8bcc2);
  background:var(--dsw-alias-bg-base, #fff);color:inherit;font-size:12px;
}

/* ── 编辑器布局 ──────────────────────────────────────────────── */
.fs-bpmn-editor{
  display:flex;flex-direction:column;flex:1;width:100%;height:100%;min-width:0;min-height:0;
  font-family:var(--dsw-font-family, system-ui, sans-serif);
  background:var(--dsw-alias-bg-base, #fff);color:var(--dsw-alias-label-primary, #1a1a1a);
}
.fs-bpmn-editor-main{display:flex;flex:1;min-width:0;min-height:0}
.fs-bpmn-editor-canvas{position:relative;flex:1 1 auto;min-width:0;min-height:0}
.fs-bpmn-editor-canvas > .bjs-container{width:100%!important;height:100%!important}
.fs-bpmn-editor-properties{
  flex:none;width:320px;min-width:0;overflow:auto;
  border-left:1px solid var(--dsw-alias-border-l1, #d9dbde);
  background:var(--dsw-alias-bg-base, #fff);
}
.fs-bpmn-editor-viewer .fs-bpmn-editor-properties{display:none}

@media (max-width:760px){
  .fs-bpmn-editor-main{flex-direction:column}
  .fs-bpmn-editor-canvas{flex:1 1 55%;min-height:240px}
  .fs-bpmn-editor-properties{
    width:100%;flex:1 1 45%;min-height:160px;
    border-left:none;border-top:1px solid var(--dsw-alias-border-l1, #d9dbde);
  }
}

/* ── 主题桥接：--bio-* → --dsw-* ─────────────────────────────── */
.bio-theme-parent{
  --bio-font-family:var(--dsw-font-family, system-ui, sans-serif);
  --bio-surface:var(--dsw-alias-bg-base, #fff);
  --bio-surface-overlay:var(--dsw-alias-bg-layer-1, #fff);
  --bio-surface-subtle:var(--dsw-alias-bg-layer-1, #f5f5f6);
  --bio-surface-medium:color-mix(in srgb, var(--dsw-alias-label-primary, #1a1a1a) 8%, var(--dsw-alias-bg-base, #fff));
  --bio-surface-strong:color-mix(in srgb, var(--dsw-alias-label-primary, #1a1a1a) 14%, var(--dsw-alias-bg-base, #fff));
  --bio-surface-inverted:color-mix(in srgb, var(--dsw-alias-label-primary, #1a1a1a) 88%, var(--dsw-alias-bg-base, #fff));
  --bio-surface-inverted-subtle:color-mix(in srgb, var(--dsw-alias-label-primary, #1a1a1a) 72%, var(--dsw-alias-bg-base, #fff));
  --bio-text:var(--dsw-alias-label-primary, #1a1a1a);
  --bio-text-subtle:var(--dsw-alias-label-secondary, #4a4a4a);
  --bio-text-subtlest:var(--dsw-alias-label-tertiary, #777);
  --bio-text-on-primary:var(--dsw-alias-label-primary-foreground, #fff);
  --bio-text-on-inverted:var(--dsw-alias-bg-base, #fff);
  --bio-border:var(--dsw-alias-border-l1, #c5c8cc);
  --bio-border-subtle:var(--dsw-alias-border-l1, #d9dbde);
  --bio-border-disabled:var(--dsw-alias-border-l2, #e3e4e6);
  --bio-border-input:var(--dsw-alias-border-l3, #b8bcc2);
  --bio-primary:var(--dsw-alias-brand-primary, #006ce0);
  --bio-primary-hover:color-mix(in srgb, var(--dsw-alias-brand-primary, #006ce0) 84%, var(--dsw-alias-label-primary, #000));
  --bio-primary-surface:color-mix(in srgb, var(--dsw-alias-brand-primary, #006ce0) 12%, transparent);
  --bio-primary-surface-strong:color-mix(in srgb, var(--dsw-alias-brand-primary, #006ce0) 26%, transparent);
  --bio-neutral:var(--dsw-alias-label-secondary, #4a4a4a);
  --bio-danger:var(--dsw-alias-state-error-primary, #d92d20);
  --bio-danger-hover:color-mix(in srgb, var(--dsw-alias-state-error-primary, #d92d20) 84%, var(--dsw-alias-label-primary, #000));
  --bio-danger-surface:color-mix(in srgb, var(--dsw-alias-state-error-primary, #d92d20) 14%, transparent);
  --bio-danger-surface-subtle:color-mix(in srgb, var(--dsw-alias-state-error-primary, #d92d20) 7%, transparent);
  --bio-warning:var(--dsw-alias-state-warn-primary, #d9822b);
  --bio-warning-hover:color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d9822b) 84%, var(--dsw-alias-label-primary, #000));
  --bio-warning-text:color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d9822b) 68%, var(--dsw-alias-label-primary, #1a1a1a));
  --bio-warning-surface:color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d9822b) 14%, transparent);
  --bio-info:var(--dsw-alias-brand-primary, #006ce0);
  --bio-info-marker:var(--dsw-alias-brand-primary, #006ce0);
  --bio-info-on-inverted:color-mix(in srgb, var(--dsw-alias-brand-primary, #006ce0) 55%, #fff);
  --bio-focus:var(--dsw-alias-brand-primary, #006ce0);
  --bio-focus-ring:color-mix(in srgb, var(--dsw-alias-brand-primary, #006ce0) 35%, transparent);
  --bio-focus-ring-danger:color-mix(in srgb, var(--dsw-alias-state-error-primary, #d92d20) 35%, transparent);
  --bio-focus-ring-warning:color-mix(in srgb, var(--dsw-alias-state-warn-primary, #d9822b) 35%, transparent);
  --bio-focus-surface:color-mix(in srgb, var(--dsw-alias-brand-primary, #006ce0) 8%, transparent);
  --bio-selected-surface:color-mix(in srgb, var(--dsw-alias-brand-primary, #006ce0) 14%, transparent);
  --bio-selected-text:var(--dsw-alias-label-primary, #1a1a1a);
  --bio-shadow:color-mix(in srgb, var(--dsw-alias-label-primary, #1a1a1a) 30%, transparent);
  --bio-shadow-subtle:color-mix(in srgb, var(--dsw-alias-label-primary, #1a1a1a) 12%, transparent);
  --bio-canvas-accent:var(--dsw-alias-brand-primary, #006ce0);
  --bio-canvas-accent-subtle:color-mix(in srgb, var(--dsw-alias-brand-primary, #006ce0) 45%, transparent);
  --bio-radius-sm:var(--dsw-radius-sm, 4px);
  --bio-radius-md:var(--dsw-radius-sm, 6px);
  --bio-radius-lg:var(--dsw-radius-md, 8px);
  --bjs-font-family:var(--dsw-font-family, system-ui, sans-serif);
  --popup-font-family:var(--dsw-font-family, system-ui, sans-serif);
  --search-font-family:var(--dsw-font-family, system-ui, sans-serif);
  --hover-tooltip-font-family:var(--dsw-font-family, system-ui, sans-serif);
  font-family:var(--dsw-font-family, system-ui, sans-serif);
  color:var(--bio-text);
}
.bio-theme-parent.bjs-container,
.bio-theme-parent .bjs-container{background-color:var(--bio-surface)}
.bio-theme-parent .djs-container{background-color:var(--bio-surface)}
.bio-theme-parent .djs-container svg{background-color:var(--bio-surface)}

/* 暗色：显式再映射一次（宿主 token 缺失时也有可读的兜底），并照顾 SVG 默认 white/black。 */
body[data-ds-dark-theme] .bio-theme-parent{
  --bio-surface:var(--dsw-alias-bg-base, #16181d);
  --bio-surface-overlay:var(--dsw-alias-bg-layer-1, #1f2229);
  --bio-surface-subtle:var(--dsw-alias-bg-layer-1, #1f2229);
  --bio-surface-medium:color-mix(in srgb, var(--dsw-alias-label-primary, #f2f3f5) 10%, var(--dsw-alias-bg-base, #16181d));
  --bio-surface-strong:color-mix(in srgb, var(--dsw-alias-label-primary, #f2f3f5) 16%, var(--dsw-alias-bg-base, #16181d));
  --bio-surface-inverted:color-mix(in srgb, var(--dsw-alias-label-primary, #f2f3f5) 88%, var(--dsw-alias-bg-base, #16181d));
  --bio-surface-inverted-subtle:color-mix(in srgb, var(--dsw-alias-label-primary, #f2f3f5) 72%, var(--dsw-alias-bg-base, #16181d));
  --bio-text:var(--dsw-alias-label-primary, #f2f3f5);
  --bio-text-subtle:var(--dsw-alias-label-secondary, #c3c6cc);
  --bio-text-subtlest:var(--dsw-alias-label-tertiary, #9aa0a8);
  --bio-text-on-primary:var(--dsw-alias-label-primary-foreground, #fff);
  --bio-text-on-inverted:var(--dsw-alias-bg-base, #16181d);
  --bio-border:var(--dsw-alias-border-l1, #3a3f47);
  --bio-border-subtle:var(--dsw-alias-border-l1, #33373e);
  --bio-border-disabled:var(--dsw-alias-border-l2, #2b2f36);
  --bio-border-input:var(--dsw-alias-border-l3, #4a5058);
  --bio-selected-text:var(--dsw-alias-label-primary, #f2f3f5);
  --bio-shadow:color-mix(in srgb, #000 60%, transparent);
  --bio-shadow-subtle:color-mix(in srgb, #000 35%, transparent);
  --popup-scrollbar-thumb-color:color-mix(in srgb, var(--dsw-alias-label-primary, #f2f3f5) 22%, transparent);
}

/* SVG：bpmn-js 默认把 fill="white" / stroke="black" 写成 presentation attribute，
   CSS 规则优先级更高，主题切换只改颜色，不改 BPMN DI 与 commandStack。 */
.bio-theme-parent .djs-visual > rect,
.bio-theme-parent .djs-visual > circle,
.bio-theme-parent .djs-visual > polygon,
.bio-theme-parent .djs-visual > ellipse{fill:var(--bio-surface)!important;stroke:var(--bio-text)!important}
.bio-theme-parent .djs-visual > path{stroke:var(--bio-text)!important}
.bio-theme-parent .djs-visual > path[fill="white"],
.bio-theme-parent .djs-visual > path[fill="#ffffff"],
.bio-theme-parent .djs-visual > path[fill="black"],
.bio-theme-parent .djs-visual > path[fill="#000000"]{fill:var(--bio-text)!important}
.bio-theme-parent .djs-visual > path[fill="none"]{fill:none!important}
.bio-theme-parent .djs-visual text,
.bio-theme-parent .djs-visual tspan{fill:var(--bio-text)!important;font-family:var(--dsw-font-family, system-ui, sans-serif)!important}
.bio-theme-parent .djs-connection .djs-visual > path{stroke:var(--bio-text)!important}
.bio-theme-parent svg defs marker path[fill="none"]{fill:none!important;stroke:var(--bio-text)!important}
.bio-theme-parent svg defs marker path:not([fill="none"]){fill:var(--bio-text)!important;stroke:var(--bio-text)!important}
.bio-theme-parent .djs-outline{stroke:var(--bio-focus)!important}
.bio-theme-parent .djs-selection-outline{stroke:var(--bio-focus)!important}
/* 水印保持官方显示逻辑：不调透明度、不隐藏、不遮挡（bpmn.io License 要求）。 */

/* 运行态 marker：只改表现层，不写 XML。 */
.bio-theme-parent .fs-runtime-active .djs-visual > rect,
.bio-theme-parent .fs-runtime-active .djs-visual > circle,
.bio-theme-parent .fs-runtime-active .djs-visual > polygon{stroke:var(--bio-primary)!important;stroke-width:2.5px}
.bio-theme-parent .fs-runtime-waiting .djs-visual > rect,
.bio-theme-parent .fs-runtime-waiting .djs-visual > circle,
.bio-theme-parent .fs-runtime-waiting .djs-visual > polygon{stroke:var(--bio-warning)!important;stroke-width:2.5px}
.bio-theme-parent .fs-runtime-completed .djs-visual > rect,
.bio-theme-parent .fs-runtime-completed .djs-visual > circle,
.bio-theme-parent .fs-runtime-completed .djs-visual > polygon{stroke:var(--dsw-alias-state-success-primary, #12805c)!important;stroke-width:2px}
.bio-theme-parent .fs-runtime-failed .djs-visual > rect,
.bio-theme-parent .fs-runtime-failed .djs-visual > circle,
.bio-theme-parent .fs-runtime-failed .djs-visual > polygon{stroke:var(--bio-danger)!important;stroke-width:2.5px}

/* 属性面板：跟随宿主字号/圆角，暗色下输入框与弹层仍可读。 */
.bio-theme-parent .bio-properties-panel{font-family:var(--dsw-font-family, system-ui, sans-serif)}
.bio-theme-parent .bio-properties-panel-input{
  border-radius:var(--bio-radius-sm);background:var(--bio-surface);color:var(--bio-text);
}
.bio-theme-parent .bio-properties-panel-input:focus{outline:none;border-color:var(--bio-focus);box-shadow:0 0 0 2px var(--bio-focus-ring)}
.bio-theme-parent .bio-properties-panel-group-header-title,
.bio-theme-parent .bio-properties-panel-label{color:var(--bio-text)}
.bio-theme-parent .bio-properties-panel-description{color:var(--bio-text-subtle)}
.bio-theme-parent .bio-properties-panel-error{color:var(--bio-danger)}
`

/** 完整样式（官方 CSS 在前，主题/布局覆盖在后）。 */
export const BPMN_EDITOR_CSS = `${BPMN_ASSETS_CSS}\n${THEME_CSS}`

let styleRefs = 0

/**
 * 注入样式（幂等）：同一个 document 只插一个 `<style data-fs-bpmn-style>`。
 * @param {Document} doc
 */
export function ensureEditorStyle(doc) {
  styleRefs += 1
  let style = doc.querySelector(`style[${STYLE_ATTR}]`)
  if (!style) {
    style = doc.createElement('style')
    style.setAttribute(STYLE_ATTR, 'client.bpmn.js')
    style.setAttribute('data-fs-bpmn-refs', '0')
    style.textContent = BPMN_EDITOR_CSS
    const parent = doc.head || doc.documentElement
    parent.appendChild(style)
  }
  style.setAttribute('data-fs-bpmn-refs', String(styleRefs))
  return style
}

/** 释放样式：引用计数归零时移除，插件卸载后不残留。 */
export function releaseEditorStyle(doc) {
  styleRefs = Math.max(0, styleRefs - 1)
  if (styleRefs > 0) return
  const style = doc.querySelector(`style[${STYLE_ATTR}]`)
  if (style && style.parentNode) style.parentNode.removeChild(style)
}
