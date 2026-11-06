/**
 * 样式词汇表：把 docs/design/02-visual-system.md 的裁决落成 CSS。
 *
 * 三条纪律：
 *  1. 颜色只允许 `--dsw-alias-*` 变量与两种混色（与 label-primary 混 = 主题自适应；
 *     与 transparent 混 = tint）。禁止与白/黑混，暗色下会失效。
 *  2. 字号地板 12px。画布文字随缩放**隐藏**而不是缩小（data-lod 三档）。
 *  3. 选中用中性 brand-primary，运行用 state-business-primary —— 两者必须可区分。
 *
 * 样式节点由页面组件渲染，面板卸载即随之移除。
 *
 * @module @feiyueve/dsh-flow-studio/client/styles
 */

/** 图形档混色（线、描边、角标底）：亮色 3.9–4.1:1，过图形门槛 3:1。 */
const R1 = (state) => `color-mix(in srgb, var(--dsw-alias-state-${state}-primary) 70%, var(--dsw-alias-label-primary))`
/** 文字档混色（12–13px 状态文字）：亮色 4.7–5.0:1，过文字门槛 4.5:1。 */
const R2 = (state) => `color-mix(in srgb, var(--dsw-alias-state-${state}-primary) 62%, var(--dsw-alias-label-primary))`

export const CSS = `
.fs-root{
  --fs-r1-warn:${R1('warn')};
  --fs-r1-success:${R1('success')};
  --fs-r1-error:${R1('error')};
  --fs-r2-warn:${R2('warn')};
  --fs-r2-success:${R2('success')};
  --fs-r2-error:${R2('error')};
  display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;
  overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  font-family:var(--dsw-font-family);font-size:13px;line-height:20px;
}
.fs-root *{box-sizing:border-box}
.fs-root button{font-family:inherit}

/* ══ 顶栏 ══════════════════════════════════════════════ */
.fs-head{
  display:flex;align-items:center;gap:8px;flex:none;height:48px;padding:0 12px;
  background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1);
}
.fs-head-titles{display:flex;flex-direction:column;justify-content:center;min-width:0;flex:1;gap:0}
.fs-title-input{
  border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-primary);
  font-size:14px;line-height:22px;font-weight:500;font-family:inherit;
  padding:0 6px;margin-left:-6px;border-radius:var(--dsw-radius-sm);min-width:120px;width:100%;outline:none;
  transition:background .15s,border-color .15s;
}
.fs-title-input:hover{background:var(--dsw-alias-interactive-bg-hover)}
.fs-title-input:focus{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base)}
.fs-sub{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);padding-left:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

.fs-toolbar{display:flex;align-items:center;gap:4px;flex:none}
.fs-tool{
  display:inline-flex;align-items:center;justify-content:center;gap:5px;height:28px;min-width:28px;padding:0 8px;
  border:1px solid transparent;border-radius:var(--dsw-radius-sm);background:transparent;
  color:var(--dsw-alias-label-secondary);font-size:12px;line-height:16px;cursor:pointer;
  transition:background .15s,color .15s,border-color .15s;
}
.fs-tool:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.fs-tool:disabled{opacity:.4;cursor:not-allowed}
.fs-tool.on{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.fs-tool:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}

.fs-btn{
  display:inline-flex;align-items:center;justify-content:center;gap:5px;height:28px;padding:0 12px;
  border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
  font-size:12px;line-height:16px;cursor:pointer;white-space:nowrap;
  transition:background .15s,border-color .15s,opacity .15s;
}
.fs-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.fs-btn:disabled{opacity:.45;cursor:not-allowed}
.fs-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.fs-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground)}
.fs-btn.primary:hover:not(:disabled){opacity:.88;background:var(--dsw-alias-brand-primary)}
.fs-btn.ghost{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary)}
.fs-btn.ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.fs-btn.danger{color:var(--fs-r2-error);border-color:color-mix(in srgb, var(--fs-r1-error) 35%, transparent)}
.fs-btn.danger:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent)}
.fs-btn.sm{height:24px;padding:0 8px;font-size:12px}

.fs-save{display:inline-flex;align-items:center;gap:5px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;padding:0 4px}
.fs-dot{width:6px;height:6px;border-radius:50%;background:var(--fs-r1-success);flex:none}
.fs-dot.dirty{background:var(--fs-r1-warn)}
.fs-dot.saving{background:var(--dsw-alias-state-business-primary)}
.fs-dot.error{background:var(--fs-r1-error)}

/* ══ 主体三栏 ══════════════════════════════════════════ */
.fs-body{display:flex;flex:1;min-height:0;min-width:0}

/* 左栏 */
.fs-rail{
  width:240px;flex:none;display:flex;flex-direction:column;min-height:0;
  background:var(--dsw-alias-bg-layer-1);border-right:1px solid var(--dsw-alias-border-l1);
  transition:width .18s ease;
}
.fs-rail.collapsed{width:44px}
.fs-rail-head{
  display:flex;align-items:center;justify-content:space-between;gap:4px;flex:none;
  padding:8px 8px 8px 12px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);
}
.fs-rail.collapsed .fs-rail-head{justify-content:center;padding:8px 0}
.fs-rail.collapsed .fs-rail-label,.fs-rail.collapsed .fs-rail-list,.fs-rail.collapsed .fs-rail-new{display:none}
.fs-rail-list{flex:1;overflow-y:auto;padding:0 8px 12px;display:flex;flex-direction:column;gap:2px}
.fs-flow{
  display:flex;flex-direction:column;gap:1px;padding:7px 8px;border-radius:var(--dsw-radius-sm);
  cursor:pointer;border-left:2px solid transparent;min-width:0;
  transition:background .15s;
}
.fs-flow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.fs-flow:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.fs-flow.active{background:var(--dsw-alias-interactive-bg-hover);border-left-color:var(--dsw-alias-state-business-primary)}
.fs-flow-name{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fs-flow-meta{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fs-flow-actions{display:flex;gap:2px;margin-top:4px}

/* 画布 */
.fs-canvas{
  position:relative;flex:1;min-width:0;min-height:0;overflow:hidden;cursor:grab;touch-action:none;
  background-color:color-mix(in srgb, var(--dsw-alias-bg-base) 96.5%, var(--dsw-alias-label-primary));
  background-image:radial-gradient(circle at 1px 1px, color-mix(in srgb, var(--dsw-alias-label-tertiary) 20%, transparent) 1px, transparent 0);
  background-size:20px 20px;
}
.fs-canvas.panning{cursor:grabbing}
.fs-canvas.linking{cursor:crosshair}
.fs-world{position:absolute;left:0;top:0;transform-origin:0 0;width:0;height:0}
.fs-edges{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;overflow:visible}

.fs-node{
  position:absolute;display:flex;flex-direction:column;gap:2px;
  padding:12px 12px 14px;border:1.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-layer-1);cursor:move;user-select:none;
  transition:border-color .15s,box-shadow .15s;
}
.fs-node:hover{border-color:var(--dsw-alias-border-l4)}
.fs-node.selected{
  border-color:var(--dsw-alias-brand-primary);
  box-shadow:0 0 0 4px color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent);
}
.fs-node.kind-start{background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, var(--dsw-alias-bg-layer-1));border-radius:999px}
.fs-node.kind-end{background:var(--dsw-alias-bg-layer-2);border-radius:999px}
.fs-node-title{
  font-size:14px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:6px;
}
.fs-node-summary{
  font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.fs-node-tags{display:flex;align-items:center;gap:4px;height:18px;flex-wrap:nowrap;overflow:hidden;margin-top:2px}
.fs-tag{
  display:inline-flex;align-items:center;gap:3px;height:18px;padding:0 6px;flex:none;
  border-radius:var(--dsw-radius-xs);font-size:12px;line-height:14px;white-space:nowrap;
}
.fs-tag.team{color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent)}
.fs-tag.skill{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}
.fs-tag.reject{color:var(--fs-r2-warn);box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--fs-r1-warn) 35%, transparent)}
.fs-tag.status{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}

.fs-members{display:flex;align-items:center;gap:6px;height:20px;margin-top:2px;overflow:hidden}
.fs-member{
  display:inline-flex;align-items:center;justify-content:center;flex:none;
  width:16px;height:16px;border-radius:50%;font-size:12px;line-height:16px;
  color:var(--dsw-alias-label-primary);
}
.fs-member.lead{width:16px;height:16px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground);font-weight:500}
.fs-members-more{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary)}

.fs-port{position:absolute;top:50%;width:10px;height:10px;margin-top:-5px;border-radius:50%;
  background:var(--dsw-alias-bg-layer-2);border:2px solid var(--dsw-alias-border-l4);
  opacity:0;transition:opacity .15s,width .15s,height .15s,margin .15s;z-index:2}
.fs-node:hover .fs-port,.fs-node.selected .fs-port{opacity:1}
.fs-port.in{left:-6px}
.fs-port.out{right:-6px}
.fs-port.out{cursor:crosshair}
.fs-port.out:hover{width:12px;height:12px;margin-top:-6px;border-color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, var(--dsw-alias-bg-layer-2))}

/* 连线 */
.fs-edge{fill:none;stroke:var(--dsw-alias-label-tertiary);stroke-width:1.5;stroke-linecap:round}
.fs-edge.reject{stroke:var(--fs-r1-warn);stroke-dasharray:6 4}
.fs-edge.selected{stroke:var(--dsw-alias-state-business-primary);stroke-width:2.5}
.fs-edge-hit{fill:none;stroke:transparent;stroke-width:14;pointer-events:stroke;cursor:pointer}
.fs-edge-label{
  font-size:12px;line-height:14px;fill:var(--fs-r2-warn);
  paint-order:stroke;stroke:var(--dsw-alias-bg-layer-1);stroke-width:3px;stroke-linejoin:round;
  user-select:none;pointer-events:none;
}
.fs-edge-label.neutral{fill:var(--dsw-alias-label-secondary)}
.fs-link-preview{fill:none;stroke:var(--dsw-alias-state-business-primary);stroke-width:1.5;stroke-dasharray:4 3}

/* 画布 HUD */
.fs-hud{position:absolute;right:12px;bottom:12px;display:flex;align-items:center;gap:2px;padding:3px;
  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);z-index:5}
.fs-hud-btn{width:26px;height:26px;border:none;border-radius:var(--dsw-radius-xs);background:transparent;
  color:var(--dsw-alias-label-secondary);font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center}
.fs-hud-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.fs-hud-val{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);min-width:38px;text-align:center;font-variant-numeric:tabular-nums}
.fs-canvas-hint{position:absolute;left:12px;bottom:12px;max-width:60%;padding:5px 9px;border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);
  font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);pointer-events:none;z-index:5}

/* 缩放等级：只降内容，不动位置 */
.fs-canvas[data-lod="mid"] .fs-node-summary{display:none}
.fs-canvas[data-lod="mid"] .fs-node-tags{display:none}
.fs-canvas[data-lod="far"] .fs-node-summary,
.fs-canvas[data-lod="far"] .fs-node-tags,
.fs-canvas[data-lod="far"] .fs-node-title,
.fs-canvas[data-lod="far"] .fs-members{display:none}
.fs-canvas[data-lod="far"] .fs-node{padding:0;min-height:0}
.fs-canvas[data-lod="far"] .fs-edge-label{display:none}
.fs-canvas[data-lod="far"]{background-size:40px 40px}

/* ══ 检查器 ════════════════════════════════════════════ */
.fs-panel{
  width:320px;flex:none;display:flex;flex-direction:column;min-height:0;
  background:var(--dsw-alias-bg-layer-1);border-left:1px solid var(--dsw-alias-border-l1);
}
.fs-panel-head{
  display:flex;align-items:center;justify-content:space-between;gap:8px;flex:none;
  height:40px;padding:0 16px;border-bottom:1px solid var(--dsw-alias-border-l1);
  font-size:13px;line-height:20px;font-weight:500;
}
.fs-panel-body{flex:1;overflow-y:auto;padding:16px 16px 24px;display:flex;flex-direction:column;gap:24px}
.fs-group{display:flex;flex-direction:column;gap:8px}
.fs-group-title{font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.fs-field{display:flex;flex-direction:column;gap:4px}
.fs-label{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.fs-hint{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-weight:400}
.fs-input,.fs-textarea,.fs-select{
  width:100%;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  font-family:inherit;font-size:13px;line-height:20px;padding:5px 8px;outline:none;
  transition:border-color .15s;
}
.fs-input:focus,.fs-textarea:focus,.fs-select:focus{border-color:var(--dsw-alias-brand-primary)}
.fs-input::placeholder,.fs-textarea::placeholder{color:var(--dsw-alias-label-tertiary)}
.fs-textarea{resize:vertical;min-height:60px;line-height:22px}
.fs-input.num{font-variant-numeric:tabular-nums}
.fs-seg{display:flex;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);overflow:hidden}
.fs-seg-btn{
  flex:1;height:28px;border:none;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);
  font-size:12px;line-height:16px;cursor:pointer;transition:background .15s,color .15s;
}
.fs-seg-btn+.fs-seg-btn{border-left:1px solid var(--dsw-alias-border-l3)}
.fs-seg-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.fs-seg-btn.on{background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);color:var(--dsw-alias-state-business-primary);font-weight:500}
.fs-divider{height:1px;background:var(--dsw-alias-border-l1);margin:0}

.fs-chips{display:flex;flex-wrap:wrap;gap:4px}
.fs-chip{display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 6px;border-radius:var(--dsw-radius-xs);
  background:var(--dsw-alias-interactive-bg-hover);font-size:12px;line-height:14px;color:var(--dsw-alias-label-secondary)}
.fs-chip button{border:none;background:transparent;color:inherit;cursor:pointer;font-size:12px;line-height:1;padding:0;opacity:.6}
.fs-chip button:hover{opacity:1;color:var(--fs-r2-error)}

.fs-skills{border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);overflow:hidden;background:var(--dsw-alias-bg-base)}
.fs-skills-filter{width:100%;border:none;border-bottom:1px solid var(--dsw-alias-border-l1);background:transparent;
  color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:16px;padding:6px 8px;outline:none}
.fs-skills-list{max-height:140px;overflow-y:auto;padding:4px}
.fs-skill{display:flex;align-items:flex-start;gap:6px;padding:4px 5px;border-radius:var(--dsw-radius-xs);cursor:pointer}
.fs-skill:hover{background:var(--dsw-alias-interactive-bg-hover)}
.fs-skill input{margin:3px 0 0;accent-color:var(--dsw-alias-state-business-primary);flex:none}
.fs-skill-name{font-size:12px;line-height:16px;color:var(--dsw-alias-label-primary);word-break:break-all}
.fs-skill-desc{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}

.fs-member-card{border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);padding:8px;
  display:flex;flex-direction:column;gap:6px;background:var(--dsw-alias-bg-base)}
.fs-member-card-head{display:flex;align-items:center;gap:6px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary)}

.fs-empty-panel{padding:32px 16px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}
.fs-empty-card{
  margin:auto;display:flex;flex-direction:column;align-items:center;gap:12px;padding:24px;
  border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);max-width:380px;
}
.fs-empty-title{font-size:16px;line-height:24px;color:var(--dsw-alias-label-primary)}
.fs-empty-desc{font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);text-align:center}

.fs-error{
  display:flex;align-items:center;gap:8px;flex:none;padding:6px 12px;
  background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, var(--dsw-alias-bg-layer-1));
  color:var(--fs-r2-error);font-size:12px;line-height:16px;
}
.fs-error .fs-tool{margin-left:auto;color:inherit}

/* ══ 状态栏 ════════════════════════════════════════════ */
.fs-status{
  display:flex;align-items:center;gap:12px;flex:none;height:28px;padding:0 12px;
  background:var(--dsw-alias-bg-layer-1);border-top:1px solid var(--dsw-alias-border-l1);
  font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);
  font-variant-numeric:tabular-nums;
}
.fs-status b{font-weight:500;color:var(--dsw-alias-label-secondary)}
.fs-status-spacer{flex:1}
.fs-status-btn{display:inline-flex;align-items:center;gap:4px;border:none;background:transparent;
  font-family:inherit;font-size:12px;line-height:16px;color:inherit;cursor:pointer;padding:0}
.fs-status-btn:hover{color:var(--dsw-alias-label-primary)}
.fs-status-ok{color:var(--fs-r2-success)}
.fs-status-warn{color:var(--fs-r2-warn)}
.fs-status-bad{color:var(--fs-r2-error)}

/* ══ 弹层 ══════════════════════════════════════════════ */
.fs-mask{position:absolute;inset:0;z-index:30;display:flex;align-items:center;justify-content:center;padding:24px;
  background:color-mix(in srgb, var(--dsw-alias-label-primary) 28%, transparent)}
.fs-modal{
  display:flex;flex-direction:column;width:min(600px,100%);max-height:80%;overflow:hidden;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-md);
}
.fs-modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex:none;
  padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:14px;line-height:22px;font-weight:500}
.fs-modal-body{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}
.fs-modal-foot{display:flex;justify-content:flex-end;gap:8px;flex:none;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l1)}
.fs-pre{margin:0;padding:12px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);
  font-family:var(--dsw-font-markdown-code-font-family);font-size:12px;line-height:20px;
  color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;max-height:340px;overflow:auto}
.fs-issue{display:flex;align-items:flex-start;gap:8px;font-size:13px;line-height:20px}
.fs-issue-mark{flex:none;width:16px;font-size:12px;line-height:20px}
.fs-issue.error .fs-issue-mark{color:var(--fs-r2-error)}
.fs-issue.warning .fs-issue-mark{color:var(--fs-r2-warn)}
.fs-issue-link{border:none;background:transparent;padding:0;margin:0;font-family:inherit;font-size:13px;line-height:20px;
  color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer}
.fs-issue-link:hover{text-decoration:underline}

@media (prefers-reduced-motion: reduce){
  .fs-root *{transition:none !important;animation:none !important}
}
`
