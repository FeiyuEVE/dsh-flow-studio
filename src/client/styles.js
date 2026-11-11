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
  --fs-r1-business:${R1('business')};
  --fs-r2-warn:${R2('warn')};
  --fs-r2-success:${R2('success')};
  --fs-r2-error:${R2('error')};
  --fs-r2-business:${R2('business')};
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

/* 顶栏运行控制（06 §11）：运行 / 停止 + 「当前节点 · 第 N 轮 · attempt M」 */
.fs-runbar{display:flex;align-items:center;gap:4px;flex:none}
.fs-live{
  display:inline-flex;align-items:center;gap:6px;flex:none;max-width:290px;min-width:0;
  font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);
  font-variant-numeric:tabular-nums;
}
.fs-live-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fs-live-dot{
  flex:none;width:8px;height:8px;border-radius:50%;
  background:var(--dsw-alias-state-business-primary);
  box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent);
}
@media (max-width:1200px){.fs-live{max-width:190px}}

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

/* v0.7 §4.3：运行记录按工作区分组（左栏分组头是 02 §3.5 允许 caption 的唯一处）。
   缺 workspacePath 的旧数据整列落进「未标注工作区」，不改变布局结构。 */
.fs-rail-runs{
  flex:none;display:flex;flex-direction:column;min-height:0;max-height:52%;overflow:hidden;
  border-top:1px solid var(--dsw-alias-border-l1);
}
.fs-rail.collapsed .fs-rail-runs{display:none}
.fs-rail-subhead{padding:8px 12px 4px;justify-content:space-between}
.fs-rail-runs-list{flex:1 1 auto;min-height:0;overflow-y:auto;padding:0 8px 8px;display:flex;flex-direction:column;gap:2px}
.fs-run-detail{display:flex;flex-direction:column;gap:1px;padding:6px 4px 8px;margin-bottom:4px;
  border-bottom:1px solid var(--dsw-alias-border-l1)}
.fs-run-detail-name{font-size:12px;line-height:16px;font-weight:500;color:var(--dsw-alias-label-primary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fs-run-detail-line{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fs-run-sup{display:flex;flex-direction:column;gap:1px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.fs-run-sup.on{color:var(--dsw-alias-label-secondary)}
.fs-run-sup-label{color:var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary));margin-right:4px}
.fs-run-sup-reason{color:var(--fs-r2-warn);word-break:break-word}

/* v0.8 §11.4：节点自审状态（只读）。节点多于 6 个时区块内部滚动，不撑爆 240px 左栏。 */
.fs-run-nodes{
  display:flex;flex-direction:column;gap:2px;margin-top:4px;min-width:0;
  font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);
}
.fs-run-nodes-head{display:flex;align-items:center;gap:4px;color:var(--dsw-alias-label-tertiary)}
.fs-run-nodes-count{font-variant-numeric:tabular-nums}
.fs-run-nodes-empty{
  font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.fs-run-nodes-body{display:flex;flex-direction:column;gap:4px;min-height:0;min-width:0}
.fs-run-nodes-body.scroll{max-height:168px;overflow-y:auto;padding-right:2px}
.fs-run-node{display:flex;flex-direction:column;gap:2px;min-width:0}
.fs-run-node-head{display:flex;align-items:center;gap:4px;min-width:0}
.fs-run-node-title{
  flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--dsw-alias-label-primary);
}
.fs-run-node-pct{flex:none;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.fs-node-state{
  flex:none;padding:0 4px;border:1px solid transparent;border-radius:var(--dsw-radius-xs);
  font-size:12px;line-height:16px;white-space:nowrap;
}
.fs-node-state.working{
  color:var(--fs-r2-business);
  border-color:color-mix(in srgb, var(--dsw-alias-state-business-primary) 38%, transparent);
  background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent);
}
.fs-node-state.done{
  color:var(--fs-r2-success);
  border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 38%, transparent);
  background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent);
}
.fs-node-state.blocked{
  color:var(--fs-r2-warn);
  border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 38%, transparent);
  background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent);
}
.fs-node-state.failed{
  color:var(--fs-r2-error);
  border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 38%, transparent);
  background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
}
.fs-run-node-verdict{
  flex:none;padding:0 3px;border-radius:var(--dsw-radius-xs);
  font-size:12px;line-height:16px;font-variant-numeric:tabular-nums;white-space:nowrap;
}
.fs-run-node-verdict.pass{color:var(--fs-r2-success);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent)}
.fs-run-node-verdict.reject{color:var(--fs-r2-error);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)}
.fs-run-node-bar{
  height:3px;border-radius:2px;overflow:hidden;
  background:color-mix(in srgb, var(--dsw-alias-label-tertiary) 18%, transparent);
}
.fs-run-node-bar-fill{display:block;height:100%;border-radius:2px;background:var(--fs-r1-business)}
.fs-run-node[data-state="done"] .fs-run-node-bar-fill{background:var(--fs-r1-success)}
.fs-run-node[data-state="blocked"] .fs-run-node-bar-fill{background:var(--fs-r1-warn)}
.fs-run-node[data-state="failed"] .fs-run-node-bar-fill{background:var(--fs-r1-error)}
.fs-run-node-members{display:flex;flex-direction:column;gap:0;padding-left:8px;min-width:0}
.fs-run-node-member{
  font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.fs-run-node-member-name{color:var(--dsw-alias-label-secondary)}
.fs-run-node-member-state.working{color:var(--fs-r2-business)}
.fs-run-node-member-state.done{color:var(--fs-r2-success)}
.fs-run-node-member-state.blocked{color:var(--fs-r2-warn)}
.fs-run-node-member-state.failed{color:var(--fs-r2-error)}
.fs-run-node-blockers{
  font-size:12px;line-height:16px;color:var(--fs-r2-warn);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.fs-rail-group{display:flex;flex-direction:column;gap:1px}
.fs-rail-group-head{
  display:flex;align-items:center;gap:4px;width:100%;padding:4px;border:1px solid transparent;
  border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-tertiary);
  font-family:inherit;font-size:12px;line-height:16px;cursor:pointer;text-align:left;
}
.fs-rail-group-head:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.fs-rail-group-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.fs-rail-caret{flex:none;width:10px;font-size:10px;line-height:16px;text-align:center}
.fs-rail-group-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fs-rail-count{flex:none;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-caption, var(--dsw-alias-label-tertiary))}
.fs-run-list{display:flex;flex-direction:column;gap:1px;padding-left:6px}
.fs-run{
  display:flex;flex-direction:column;gap:1px;padding:5px 8px;min-width:0;
  border:1px solid transparent;border-left:2px solid transparent;border-radius:var(--dsw-radius-sm);
  background:transparent;font-family:inherit;text-align:left;cursor:pointer;
}
.fs-run:hover{background:var(--dsw-alias-interactive-bg-hover)}
.fs-run.on{background:var(--dsw-alias-interactive-bg-hover);border-left-color:var(--dsw-alias-state-business-primary)}
.fs-run:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.fs-run-name{font-size:12px;line-height:16px;color:var(--dsw-alias-label-primary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fs-run-meta{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fs-run-wt{color:var(--fs-r2-warn)}

/* 画布 */
.fs-canvas{
  position:relative;flex:1;min-width:0;min-height:0;overflow:hidden;cursor:grab;touch-action:none;
  background-color:color-mix(in srgb, var(--dsw-alias-bg-base) 96.5%, var(--dsw-alias-label-primary));
  background-image:radial-gradient(circle at 1px 1px, color-mix(in srgb, var(--dsw-alias-label-tertiary) 20%, transparent) 1px, transparent 0);
  background-size:20px 20px;
}
.fs-canvas.locked{cursor:default}
.fs-canvas-static{overflow:hidden}
.fs-canvas-empty{
  position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:4;
  padding:10px 14px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);
  border:1px dashed var(--dsw-alias-border-l3);font-size:12px;line-height:16px;
  color:var(--dsw-alias-label-secondary);pointer-events:none;
}
.fs-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.fs-canvas-lock{
  position:absolute;left:12px;top:12px;z-index:6;max-width:62%;padding:5px 9px;
  border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l2);font-size:12px;line-height:16px;
  color:var(--dsw-alias-label-secondary);pointer-events:none;
}
.fs-world{position:absolute;left:0;top:0;transform-origin:0 0;width:0;height:0}
.fs-edges{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;overflow:visible}

/* ══ React Flow 结构（只保留用到的部分；颜色全部走宿主 token）════════════ */
.react-flow{
  position:relative;width:100%;height:100%;direction:ltr;background-color:transparent;
  --xy-edge-stroke:var(--dsw-alias-label-tertiary);
  --xy-edge-stroke-width:1.5;
  --xy-edge-stroke-selected:var(--dsw-alias-state-business-primary);
  --xy-connectionline-stroke:var(--dsw-alias-state-business-primary);
  --xy-connectionline-stroke-width:1.5;
  --xy-node-border:1px solid var(--dsw-alias-border-l3);
  --xy-node-background-color:var(--dsw-alias-bg-layer-1);
  --xy-node-color:var(--dsw-alias-label-primary);
  --xy-handle-background-color:var(--dsw-alias-bg-layer-2);
  --xy-handle-border-color:var(--dsw-alias-border-l4);
  --xy-selection-background-color:color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent);
  --xy-selection-border:1px dashed var(--dsw-alias-state-business-primary);
  --xy-attribution-background-color:color-mix(in srgb, var(--dsw-alias-bg-layer-2) 80%, transparent);
}
.react-flow__container{position:absolute;width:100%;height:100%;top:0;left:0}
.react-flow__pane{z-index:1;touch-action:none;cursor:grab}
.react-flow__pane.dragging{cursor:grabbing}
.react-flow__pane.selection{cursor:crosshair}
.fs-canvas-flow.locked .react-flow__pane{cursor:default}
.react-flow__viewport{transform-origin:0 0;z-index:2;pointer-events:none}
.react-flow__renderer{z-index:4}
.react-flow__selection{z-index:6;background:var(--xy-selection-background-color);border:var(--xy-selection-border)}
.react-flow__nodesselection{z-index:3;transform-origin:left top;pointer-events:none}
.react-flow__nodesselection-rect{position:absolute;pointer-events:all;cursor:grab;background:var(--xy-selection-background-color);border:var(--xy-selection-border)}
.react-flow .react-flow__edges{position:absolute}
.react-flow .react-flow__edges svg{overflow:visible;position:absolute;pointer-events:none}
.react-flow__edge{pointer-events:visibleStroke}
.react-flow__edge.selectable{cursor:pointer}
.react-flow__edge.inactive{pointer-events:none}
.react-flow__edge.selected,.react-flow__edge:focus,.react-flow__edge:focus-visible{outline:none}
.react-flow__edge-textwrapper{pointer-events:all}
.react-flow__edge .react-flow__edge-text{pointer-events:none;user-select:none}
.react-flow__connection{pointer-events:none}
.react-flow__connection-path,.react-flow__connectionline .react-flow__connection-path{fill:none}
.react-flow__connectionline{z-index:1001;overflow:visible;position:absolute}
.react-flow__nodes{pointer-events:none;transform-origin:0 0}
.react-flow__node{position:absolute;user-select:none;pointer-events:all;transform-origin:0 0;box-sizing:border-box;cursor:default}
.react-flow__node.selectable{cursor:pointer}
.react-flow__node.draggable{cursor:grab;pointer-events:all}
.react-flow__node.draggable.dragging{cursor:grabbing}
.react-flow__node:focus,.react-flow__node:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px;border-radius:var(--dsw-radius-sm)}
.react-flow__handle{position:absolute;pointer-events:none;min-width:5px;min-height:5px}
.react-flow__handle.connectionindicator{pointer-events:all;cursor:crosshair}
.react-flow__handle-bottom{top:auto;left:50%;bottom:0;transform:translate(-50%,50%)}
.react-flow__handle-top{top:0;left:50%;transform:translate(-50%,-50%)}
.react-flow__handle-left{top:50%;left:0;transform:translate(-50%,-50%)}
.react-flow__handle-right{top:50%;right:0;transform:translate(50%,-50%)}
.react-flow__panel{position:absolute;z-index:5;margin:15px}
.react-flow__attribution{font-size:11px;line-height:14px;padding:2px 3px;margin:0;
  background:var(--xy-attribution-background-color);border-radius:var(--dsw-radius-xs)}
.react-flow__attribution a{text-decoration:none;color:var(--dsw-alias-label-tertiary)}
.react-flow__edgelabel-renderer{position:absolute;width:100%;height:100%;pointer-events:none;user-select:none;left:0;top:0}
.react-flow__viewport-portal{position:absolute;width:100%;height:100%;left:0;top:0;user-select:none}
@keyframes dashdraw{from{stroke-dashoffset:10}}

/* ══ 节点卡 ═════════════════════════════════════════════ */
.fs-node{
  position:relative;display:flex;flex-direction:column;gap:2px;width:100%;height:100%;
  padding:10px 12px 12px;border:1.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-layer-1);cursor:move;user-select:none;overflow:visible;
  box-shadow:0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent);
  transition:border-color .15s,box-shadow .15s;
}
.fs-node:hover{
  border-color:var(--dsw-alias-border-l4);
  box-shadow:0 6px 18px color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent);
}
.fs-node.locked{cursor:default}
.fs-node.has-state .fs-node-head{padding-right:18px}
.fs-node.selected{
  border-color:var(--dsw-alias-brand-primary);
  box-shadow:0 0 0 4px color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent);
}
.fs-node.fs-link-target{border-color:var(--dsw-alias-state-business-primary)}
.fs-node.fs-link-active{
  outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:3px;
  box-shadow:0 0 0 4px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent);
}
.fs-node.kind-start{background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, var(--dsw-alias-bg-layer-1));border-radius:var(--dsw-radius-xl)}
.fs-node.kind-end{background:var(--dsw-alias-bg-layer-2);border-radius:var(--dsw-radius-xl)}
.fs-node-head{display:flex;align-items:center;gap:6px;min-width:0;padding-bottom:3px;
  border-bottom:1px solid var(--dsw-alias-border-l1)}
.fs-node-title{
  flex:1;min-width:0;font-size:15px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.fs-mode-badge{
  flex:none;height:16px;padding:0 5px;border-radius:var(--dsw-radius-xs);
  font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);
  background:var(--dsw-alias-interactive-bg-hover);white-space:nowrap;
}
.fs-node-summary{
  font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.fs-node-tags{display:flex;align-items:center;gap:4px;height:18px;flex-wrap:nowrap;overflow:hidden;margin-top:auto}
.fs-tag{
  display:inline-flex;align-items:center;gap:3px;height:18px;padding:0 6px;flex:none;
  border-radius:var(--dsw-radius-xs);font-size:12px;line-height:14px;white-space:nowrap;
}
.fs-tag.team{color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent)}
.fs-tag.skill{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}
.fs-tag.rounds,.fs-tag.attempt{color:var(--dsw-alias-label-tertiary);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2)}
.fs-tag.invalid{color:var(--fs-r2-warn);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent)}
.fs-tag.reject{color:var(--fs-r2-warn);box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--fs-r1-warn) 35%, transparent)}
.fs-tag.status{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}

/* 运行态（06 §11）：形状 + 文字是主通道，颜色只加速。
   运行中 = business 环；通过 / 打回 / 失败只改描边与角标文字，不新造颜色。 */
.fs-node.run-state-running{
  border-color:var(--dsw-alias-state-business-primary);
  outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;
}
.fs-node.run-state-passed{border-color:var(--fs-r1-success)}
.fs-node.run-state-rejected{border-color:var(--fs-r1-warn)}
.fs-node.run-state-failed{border-color:var(--fs-r1-error)}
.fs-node.run-state-skipped{border-color:var(--dsw-alias-border-l4)}
.fs-tag.state{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}
.fs-tag.state.business{
  color:var(--dsw-alias-state-business-primary);
  background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);
}
.fs-tag.state.success{
  color:var(--fs-r2-success);
  background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent);
}
.fs-tag.state.warn{
  color:var(--fs-r2-warn);
  background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);
}
.fs-tag.state.error{
  color:var(--fs-r2-error);
  background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);
}
.fs-tag.state.idle{
  color:var(--dsw-alias-label-tertiary);background:transparent;
  box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2);
}
.fs-tag.state.neutral{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}

/* 成员行：首字母 + 角色。身份不靠色相区分（宿主没有 categorical 色板）。 */
.fs-members{display:flex;align-items:center;gap:3px;height:18px;margin-top:1px;overflow:hidden}
.fs-member{
  display:inline-flex;align-items:center;gap:2px;flex:none;max-width:50px;
  height:18px;padding:0 4px;border-radius:var(--dsw-radius-xs);
  background:var(--dsw-alias-interactive-bg-hover);font-size:12px;line-height:16px;
  color:var(--dsw-alias-label-primary);overflow:hidden;
}
.fs-member.lead{
  width:18px;padding:0;justify-content:center;border-radius:var(--dsw-radius-xs);
  background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground);font-weight:500;
}
.fs-member-initial{flex:none;font-weight:600}
.fs-member-role{
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--dsw-alias-label-secondary);font-size:12px;
}
.fs-members-more{flex:none;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary)}

/* 运行状态角标：near / mid 用右上角形状 + 文字标签，far 用居中纯形状。 */
.fs-state-mark{
  position:absolute;right:7px;top:6px;display:none;align-items:center;justify-content:center;
  width:16px;height:16px;font-size:13px;line-height:16px;font-weight:600;
  color:var(--dsw-alias-label-primary);pointer-events:none;
}
.fs-node.has-state .fs-state-mark{display:inline-flex}

/* 节点工具条：hover / 键盘聚焦时浮出，不常驻占版面。 */
.fs-node-tools{
  position:absolute;right:6px;top:-14px;z-index:3;display:flex;align-items:center;gap:2px;
  padding:2px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l2);box-shadow:0 2px 8px color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent);
  opacity:0;transform:translateY(2px);pointer-events:none;transition:opacity .15s,transform .15s;
}
.fs-node:hover .fs-node-tools,.fs-node:focus-within .fs-node-tools,.fs-node.selected .fs-node-tools{opacity:1;transform:none;pointer-events:auto}
.fs-node-tool{
  width:22px;height:22px;border:none;border-radius:var(--dsw-radius-xs);background:transparent;
  color:var(--dsw-alias-label-secondary);font-size:12px;line-height:16px;cursor:pointer;
  display:inline-flex;align-items:center;justify-content:center;
}
.fs-node-tool:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.fs-node-tool.danger:hover{color:var(--fs-r2-error)}
.fs-node-tool:disabled{opacity:.4;cursor:not-allowed}
.fs-node-tool:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}

/* 端口 */
.fs-port{
  position:absolute;top:50%;width:10px;height:10px;margin-top:-5px;border-radius:50%;
  background:var(--dsw-alias-bg-layer-2);border:2px solid var(--dsw-alias-border-l4);z-index:2;
}
.fs-port.in{left:-6px}
.fs-port.out{right:-6px}
.fs-handle{
  width:10px;height:10px;border-radius:50%;background:var(--dsw-alias-bg-layer-2);
  border:2px solid var(--dsw-alias-border-l4);opacity:0;z-index:2;
  transition:opacity .15s,width .15s,height .15s,border-color .15s;
}
.react-flow__node:hover .fs-handle,.react-flow__node.selected .fs-handle,
.fs-node:hover .fs-handle,.fs-node.selected .fs-handle,.fs-handle.connectionindicator{opacity:1}
.fs-handle.fs-handle-disabled{opacity:0!important;pointer-events:none!important}
.fs-handle:hover{width:12px;height:12px;border-color:var(--dsw-alias-state-business-primary);
  background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, var(--dsw-alias-bg-layer-2))}

/* 连线 */
.fs-edge-path{fill:none;stroke:var(--dsw-alias-label-tertiary);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.fs-edge-path.fs-edge-reject{stroke:var(--fs-r1-warn);stroke-dasharray:6 4}
.fs-edge-path.selected{stroke:var(--dsw-alias-state-business-primary);stroke-width:2.5}
.fs-arrow-head{fill:var(--dsw-alias-label-tertiary)}
.fs-arrow-head.reject{fill:var(--fs-r1-warn)}
.fs-arrow-head.selected{fill:var(--dsw-alias-state-business-primary)}
.react-flow__edge.animated .fs-edge-path{stroke-dasharray:6 4;animation:fs-edge-dash 1.2s linear infinite}
@keyframes fs-edge-dash{to{stroke-dashoffset:-20}}
.fs-edge-label{
  font-size:12px;line-height:14px;fill:var(--fs-r2-warn);
  paint-order:stroke;stroke:var(--dsw-alias-bg-layer-1);stroke-width:3px;stroke-linejoin:round;
  user-select:none;pointer-events:none;
}
.fs-edge-label.reject{fill:var(--fs-r2-warn)}
.fs-edge-tag{
  position:absolute;pointer-events:none;padding:1px 6px;border-radius:var(--dsw-radius-xs);
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);
  font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);
  white-space:nowrap;font-variant-numeric:tabular-nums;
  box-shadow:0 1px 4px color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent);
}
.fs-edge-tag.reject{color:var(--fs-r2-warn)}
.fs-edge-tag.selected{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}
.fs-edge-tag.overflow{color:var(--dsw-alias-label-secondary)}
.fs-edge-flag{
  font-size:12px;line-height:14px;fill:var(--dsw-alias-label-secondary);
  font-variant-numeric:tabular-nums;paint-order:stroke;
  stroke:var(--dsw-alias-bg-layer-1);stroke-width:3px;stroke-linejoin:round;
}
.fs-edge-flag.reject{fill:var(--fs-r2-warn)}

/* 画布 HUD */
.fs-hud{position:absolute;right:12px;bottom:12px;display:flex;align-items:center;gap:2px;padding:3px;
  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);z-index:5}
.fs-hud-btn{width:26px;height:26px;border:none;border-radius:var(--dsw-radius-xs);background:transparent;
  color:var(--dsw-alias-label-secondary);font-size:13px;cursor:pointer;display:flex;align-items:center;justify-content:center}
.fs-hud-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.fs-hud-val{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);min-width:38px;text-align:center;font-variant-numeric:tabular-nums}
.fs-hud-lod{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);padding:0 5px 0 3px;white-space:nowrap}
.fs-canvas-hint{position:absolute;left:12px;bottom:12px;max-width:60%;padding:5px 9px;border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);
  font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);pointer-events:none;z-index:5}
.fs-canvas-note{position:absolute;right:12px;top:12px;padding:5px 9px;border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);
  font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);pointer-events:none;z-index:5}
/* B1：事件窗口截断提示与「还有 N 列」错开，避免两条 note 叠在一起。 */
.fs-canvas-event-note{top:40px}

/* 键盘连线待定：候选节点高亮 + 「到 <节点名>」可读列表 */
.fs-link-picker{position:absolute;left:12px;top:12px;z-index:6;display:flex;flex-direction:column;gap:6px;
  padding:10px;max-width:300px;background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}
.fs-link-picker-head{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.fs-link-list{display:flex;flex-direction:column;gap:2px;max-height:200px;overflow-y:auto}
.fs-link-option{display:block;width:100%;text-align:left;border:1px solid transparent;background:transparent;
  border-radius:var(--dsw-radius-xs);padding:4px 6px;font-family:inherit;font-size:12px;line-height:16px;
  color:var(--dsw-alias-label-secondary);cursor:pointer}
.fs-link-option:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.fs-link-option.on{background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent);
  border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}
.fs-link-option:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.fs-link-picker-hint{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary)}

/* 缩放等级：只降内容，不动位置 */
.fs-canvas[data-lod="mid"] .fs-node-summary{display:none}
.fs-canvas[data-lod="mid"] .fs-node-tags{display:none}
/* 运行态角标在紧凑档保留：状态是运行时的主信息，不能因为缩放只剩颜色。
   设计态标签（skill 数量等）照旧隐藏，避免挤爆卡片。 */
.fs-canvas[data-lod="mid"] .fs-node.has-state .fs-node-tags{display:flex}
.fs-canvas[data-lod="mid"] .fs-node.has-state .fs-node-tags .fs-tag.skill{display:none}
.fs-canvas[data-lod="mid"] .fs-edge-tag{padding:0 4px}
.fs-canvas[data-lod="far"] .fs-node-summary,
.fs-canvas[data-lod="far"] .fs-node-tags,
.fs-canvas[data-lod="far"] .fs-node-title,
.fs-canvas[data-lod="far"] .fs-mode-badge,
.fs-canvas[data-lod="far"] .fs-node-head,
.fs-canvas[data-lod="far"] .fs-members,
.fs-canvas[data-lod="far"] .fs-node-tools{display:none}
.fs-canvas[data-lod="far"] .fs-node{padding:0;min-height:0}
/* M3：far 档把状态压成纯形状角标；双环 ◎ 表示运行中，不依赖颜色也能分辨。 */
.fs-canvas[data-lod="far"] .fs-node .fs-state-mark,
.fs-canvas[data-lod="far"] .fs-node.has-state .fs-state-mark{
  display:flex;position:absolute;inset:0;align-items:center;justify-content:center;
  font-size:28px;line-height:32px;font-weight:600;color:var(--dsw-alias-label-primary);
  pointer-events:none;
}
.fs-canvas[data-lod="far"] .fs-node.kind-start .fs-state-mark,
.fs-canvas[data-lod="far"] .fs-node.kind-end .fs-state-mark{font-size:20px;line-height:24px}
.fs-canvas[data-lod="far"] .fs-state-mark.kind-mark{color:var(--dsw-alias-label-secondary)}
.fs-canvas[data-lod="far"] .fs-node.run-state-running .fs-state-mark{
  width:36px;height:36px;margin:auto;border:2px double var(--dsw-alias-label-primary);
  border-radius:var(--dsw-radius-panel);
  font-size:0;line-height:0;
}
.fs-canvas[data-lod="far"] .fs-edge-tag,
.fs-canvas[data-lod="far"] .fs-edge-label{display:none}
.fs-canvas[data-lod="far"]{background-size:40px 40px}

/* 暗色主题：token 已自适应，这里只调网格与浮层的对比度。 */
body[data-ds-dark-theme] .fs-canvas{
  background-color:color-mix(in srgb, var(--dsw-alias-bg-base) 94%, var(--dsw-alias-label-primary));
  background-image:radial-gradient(circle at 1px 1px, color-mix(in srgb, var(--dsw-alias-label-tertiary) 26%, transparent) 1px, transparent 0);
}
body[data-ds-dark-theme] .fs-node{box-shadow:0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)}
body[data-ds-dark-theme] .fs-node-tools,
body[data-ds-dark-theme] .fs-edge-tag{box-shadow:0 2px 8px color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent)}

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
.fs-panel-body{
  flex:1;overflow-y:auto;padding:16px 16px 24px;display:flex;flex-direction:column;gap:24px;
  border:0;margin:0;min-width:0;
}
.fs-panel-body:disabled{opacity:.72}
.fs-panel.locked .fs-panel-body{overflow-y:auto}
.fs-panel-lock-badge{
  flex:none;font-size:12px;line-height:16px;font-weight:400;
  color:var(--fs-r2-warn);padding:0 8px;border-radius:var(--dsw-radius-xs);
  background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);
}
/* v0.7 §6：外部执行器要在面板头部与表单顶部都能一眼看到（不是高级设置）。 */
.fs-panel-head-main{display:flex;align-items:center;gap:6px;min-width:0}
.fs-panel-exec-badge{
  flex:none;font-size:12px;line-height:16px;font-weight:400;padding:0 8px;
  border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-state-business-primary);
  background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);
}
.fs-exec-banner{
  display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:8px 10px;
  border-radius:var(--dsw-radius-sm);
  border:1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 32%, transparent);
  background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, var(--dsw-alias-bg-layer-1));
  font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);
}
.fs-exec-badge{
  flex:none;padding:0 6px;border-radius:var(--dsw-radius-xs);
  background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 16%, transparent);
  color:var(--dsw-alias-state-business-primary);font-size:12px;line-height:16px;
}
.fs-field-error{
  display:flex;align-items:center;gap:8px;flex-wrap:wrap;
  font-size:12px;line-height:16px;color:var(--fs-r2-error);
}
.fs-field-error .fs-btn{color:var(--fs-r2-error)}
.fs-input.bad{border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 55%, transparent)}
.fs-lock-banner{
  flex:none;margin:8px 12px 0;padding:6px 8px;border-radius:var(--dsw-radius-sm);
  border:1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 32%, transparent);
  background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, var(--dsw-alias-bg-layer-1));
  color:var(--fs-r2-warn);font-size:12px;line-height:16px;
}
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

/* 可点按移动入口（拖动替代） */
.fs-pos{display:flex;flex-direction:column;gap:6px}
.fs-pos-val{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.fs-pos-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:4px}
.fs-pos-btn{width:100%;padding:0}
.fs-pos-gap{display:block}
.fs-seg{display:flex;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);overflow:hidden}
.fs-seg-btn{
  flex:1;height:28px;border:none;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);
  font-size:12px;line-height:16px;cursor:pointer;transition:background .15s,color .15s;
}
.fs-seg-btn+.fs-seg-btn{border-left:1px solid var(--dsw-alias-border-l3)}
.fs-seg-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.fs-seg-btn.on{background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);color:var(--dsw-alias-state-business-primary);font-weight:500}
/* 外部执行器下 team 选项禁用（07 §6）：禁用态要看得出来，且不响应 hover。 */
.fs-seg-btn:disabled{opacity:.45;cursor:not-allowed;pointer-events:none}
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

/* 0.10 R7：内联 combobox（收起只留触发按钮；展开在文档流内，不用浮层以免被面板裁切）。 */
.fs-skills-combo{display:flex;flex-direction:column;gap:6px;min-width:0}
.fs-skills-trigger{
  display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;min-height:32px;
  padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  font-family:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer;
}
.fs-skills-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}
.fs-skills-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.fs-skills-panel{
  display:flex;flex-direction:column;gap:6px;padding:8px;
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-base);
}
.fs-skills-search{
  width:100%;height:30px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:20px;
}
.fs-skills-search:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.fs-skills-listbox{display:flex;flex-direction:column;gap:2px;max-height:280px;overflow-y:auto}
.fs-skills-option{
  display:flex;flex-direction:column;gap:2px;padding:6px 8px;border-radius:var(--dsw-radius-sm);
  color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;cursor:pointer;
}
.fs-skills-option:hover{background:var(--dsw-alias-interactive-bg-hover)}
.fs-skills-option.on{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}
.fs-skills-option[aria-disabled="true"]{opacity:.55;cursor:not-allowed}
.fs-skills-option-name{font-weight:500;word-break:break-all}
.fs-skills-option-desc{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);word-break:break-word}
.fs-skills-empty{padding:8px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.fs-skills-limit{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary)}

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

/* 本地草稿横幅：只有恢复 / 丢弃两个动作，措辞与实现一致 */
.fs-draft{
  display:flex;align-items:center;gap:8px;flex:none;padding:6px 12px;
  background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, var(--dsw-alias-bg-layer-1));
  border-bottom:1px solid var(--dsw-alias-border-l1);
  color:var(--fs-r2-warn);font-size:12px;line-height:16px;
}
.fs-draft-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ══ 状态栏 ════════════════════════════════════════════ */
.fs-status{
  display:flex;align-items:center;gap:12px;flex:none;height:28px;padding:0 12px;
  background:var(--dsw-alias-bg-layer-1);border-top:1px solid var(--dsw-alias-border-l1);
  font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);
  font-variant-numeric:tabular-nums;
}
.fs-status b{font-weight:500;color:var(--dsw-alias-label-secondary)}
.fs-status-spacer{flex:1}
.fs-status-live{max-width:52%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
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

/* ══ 运行日志抽屉（收起 40 / 展开 340，05 §6）════════════ */
.fs-log{
  flex:none;height:40px;display:flex;flex-direction:column;min-width:0;overflow:hidden;
  background:var(--dsw-alias-bg-layer-1);border-top:1px solid var(--dsw-alias-border-l2);
  transition:height .18s ease;
}
.fs-log.open{height:340px}
/* 上边缘拖拽条：平时一条 1px 分隔线，hover / focus-visible 变明显 + 2px focus ring。
   拖动期间根节点加 .resizing 关掉 height 过渡，否则会「拖不动 / 回弹」。 */
.fs-log-grip{
  flex:none;display:block;width:100%;height:6px;padding:0;margin:0;border:0;
  background:transparent;cursor:row-resize;touch-action:none;
  user-select:none;-webkit-user-select:none;
}
.fs-log-grip::before{
  content:'';display:block;height:1px;margin:2px 0 0;background:var(--dsw-alias-border-l1);
}
.fs-log-grip:hover::before,.fs-log-grip:focus-visible::before,.fs-log.resizing .fs-log-grip::before{
  height:3px;margin-top:1px;background:var(--dsw-alias-brand-primary);
}
.fs-log-grip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.fs-log.resizing{transition:none}
.fs-log.resizing,.fs-log.resizing *{user-select:none;-webkit-user-select:none}
/* 收起态（40px 折叠条）不显示拖拽条：既不占高，也不进 Tab 序。 */
.fs-log:not(.open) .fs-log-grip{display:none}
.fs-log-bar{flex:none;display:flex;align-items:center;gap:8px;height:40px;padding:0 8px 0 4px;min-width:0}

.fs-log-toggle{
  display:flex;align-items:center;gap:8px;flex:1;min-width:0;height:32px;padding:0 8px;
  border:1px solid transparent;border-radius:var(--dsw-radius-sm);background:transparent;
  color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:16px;
  cursor:pointer;text-align:left;
}
.fs-log-toggle:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.fs-log-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.fs-log-caret{flex:none;width:12px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px}
.fs-log-dot{flex:none;width:8px;height:8px;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-border-l4)}
.fs-log-dot.success{background:var(--fs-r1-success, var(--dsw-alias-state-success-primary))}
.fs-log-dot.business{background:var(--dsw-alias-state-business-primary)}
.fs-log-dot.error{background:var(--fs-r1-error, var(--dsw-alias-state-error-primary))}
.fs-log-dot.warn{background:var(--fs-r1-warn, var(--dsw-alias-state-warn-primary))}
.fs-log-dot.neutral{background:transparent;box-shadow:inset 0 0 0 1.5px var(--dsw-alias-border-l4)}
.fs-log-title{
  flex:none;max-width:34%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary);
}
/* M4：40px 收起条的主值 = 验收条目通过率；token 明细下沉到展开态。 */
.fs-log-main{
  flex:none;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:14px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary);
  font-variant-numeric:tabular-nums;
}
.fs-log-main.missing{color:var(--dsw-alias-label-tertiary);font-weight:400}
/* 展开态五项聚合 + token 四段（04 §3.2）：一行迷你 stat，不再回流 40px 条。 */
.fs-log-stats{
  flex:none;display:flex;align-items:stretch;gap:16px;min-height:58px;height:auto;padding:4px 10px;
  overflow-x:auto;overflow-y:hidden;border-top:1px solid var(--dsw-alias-border-l1);
}
.fs-log-stats-empty{
  display:flex;align-items:center;height:40px;font-size:12px;line-height:16px;
  color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.fs-stat{
  display:flex;flex-direction:column;justify-content:center;flex:none;min-width:72px;max-width:220px;
  padding-left:6px;border-left:2px solid var(--dsw-alias-border-l3);min-height:0;
}
.fs-stat-success{border-left-color:var(--fs-r1-success)}
.fs-stat-error{border-left-color:var(--fs-r1-error)}
.fs-stat-warn{border-left-color:var(--fs-r1-warn)}
.fs-stat-brand,.fs-stat-business{border-left-color:var(--dsw-alias-state-business-primary)}
.fs-stat-label{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.fs-stat-value{
  font-size:14px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-primary);
  font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.fs-stat-hint{
  font-size:12px;line-height:14px;color:var(--dsw-alias-label-tertiary);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.fs-log-tokens{
  flex:none;font-family:var(--dsw-font-markdown-code-font-family);font-size:12px;line-height:16px;
  font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);white-space:nowrap;
}
.fs-log-breakdown{
  flex:none;max-width:38%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:var(--dsw-font-markdown-code-font-family);font-size:12px;line-height:16px;
  font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary);
}
.fs-log-pill{
  flex:none;display:inline-flex;align-items:center;height:18px;max-width:180px;padding:0 8px;
  border-radius:var(--dsw-radius-panel);font-size:12px;line-height:14px;font-weight:500;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);
}
/* 中性 pill：没拿到 quality 证据时用，明确「不是绿灯」。 */
.fs-log-pill.neutral{
  color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);
  box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2);
}
.fs-log-pill.success{
  color:var(--fs-r2-success, var(--dsw-alias-state-success-primary));
  background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent);
  box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--fs-r1-success, var(--dsw-alias-state-success-primary)) 35%, transparent);
}
.fs-log-pill.warn{
  color:var(--fs-r2-warn, var(--dsw-alias-state-warn-primary));
  background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);
  box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--fs-r1-warn, var(--dsw-alias-state-warn-primary)) 35%, transparent);
}
.fs-log-pill.error{
  color:var(--fs-r2-error, var(--dsw-alias-state-error-primary));
  background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);
  box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, transparent);
}
.fs-log-pill.business{
  color:var(--dsw-alias-state-business-primary);
  background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);
}
/* 06 §13.8 桩数据 badge：必须一眼可辨（不是「未检测」，是「这批数据不是真的」）。 */
.fs-log-pill.stub{
  color:var(--fs-r2-warn, var(--dsw-alias-state-warn-primary));
  background:transparent;
  box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--fs-r1-warn, var(--dsw-alias-state-warn-primary)) 60%, transparent);
  font-variant-numeric:tabular-nums;
  letter-spacing:.02em;
}
.fs-log-pill.stub::before{content:'⚠';margin-right:4px;font-size:11px;line-height:1}
.fs-log-note{
  flex:none;max-width:30%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:12px;line-height:16px;color:var(--fs-r2-error, var(--dsw-alias-state-error-primary));
}
.fs-log-actions{display:flex;align-items:center;gap:2px;flex:none;min-width:0}
.fs-log-action{
  display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 8px;
  border:1px solid transparent;border-radius:var(--dsw-radius-sm);background:transparent;
  color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:16px;
  text-decoration:none;white-space:nowrap;cursor:pointer;
}
.fs-log-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.fs-log-action:disabled{opacity:.45;cursor:not-allowed}
.fs-log-action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}

.fs-log-body{flex:1;min-height:0;display:flex;flex-direction:column;border-top:1px solid var(--dsw-alias-border-l1);overflow:hidden}
.fs-log-banner{
  flex:none;display:flex;align-items:center;gap:8px;padding:2px 8px;
  border-bottom:1px solid var(--dsw-alias-border-l1);
  color:var(--fs-r2-error, var(--dsw-alias-state-error-primary));font-size:12px;line-height:16px;
}
/* 续跑世系（0.10 R8）：放 body 顶部，不挤 40px 动作条。 */
.fs-log-lineage{
  flex:none;display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:2px 10px;
  border-bottom:1px solid var(--dsw-alias-border-l1);
  font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);
}
.fs-log-grid{flex:1;min-height:0;display:grid;grid-template-columns:220px minmax(0,1fr) 300px;overflow:hidden}
.fs-log-col{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}
.fs-log-col + .fs-log-col{border-left:1px solid var(--dsw-alias-border-l1)}
.fs-log-col-head{
  flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;height:28px;
  padding:0 10px;font-size:12px;line-height:16px;font-weight:500;color:var(--dsw-alias-label-secondary);
}
.fs-log-count{
  min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-weight:400;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;
}

.fs-log-run-list{flex:1;min-height:0;overflow-y:auto;padding:0 6px 6px;display:flex;flex-direction:column;gap:2px}
.fs-log-run{
  display:flex;flex-direction:column;min-width:0;padding:3px 8px;border:none;
  border-left:2px solid transparent;border-radius:var(--dsw-radius-sm);background:transparent;
  color:inherit;font-family:inherit;text-align:left;cursor:pointer;
}
.fs-log-run:hover{background:var(--dsw-alias-interactive-bg-hover)}
.fs-log-run.on{background:var(--dsw-alias-interactive-bg-hover);border-left-color:var(--dsw-alias-state-business-primary)}
.fs-log-run:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.fs-log-run-name{
  font-size:12px;line-height:16px;color:var(--dsw-alias-label-primary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}
.fs-log-run-meta{
  font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);
  font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}

.fs-log-filters{flex:none;display:flex;gap:6px;padding:0 8px 4px;min-width:0}
.fs-log-filter{
  display:flex;align-items:center;gap:4px;flex:1;min-width:0;
  font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);
}
.fs-log-select{
  flex:1;min-width:0;width:100%;height:24px;padding:0 4px;outline:none;
  border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs);
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  font-family:inherit;font-size:12px;line-height:16px;
}
.fs-log-select:focus{border-color:var(--dsw-alias-brand-primary)}

.fs-log-event-list{flex:1;min-height:0;overflow-y:auto;padding:0 4px;outline:none}
.fs-log-event-list:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.fs-log-event{
  display:flex;align-items:center;gap:6px;min-width:0;padding:2px 6px;
  border-radius:var(--dsw-radius-xs);cursor:pointer;
}
.fs-log-event:hover{background:var(--dsw-alias-interactive-bg-hover)}
.fs-log-event.active,.fs-log-event[aria-selected="true"]{
  background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);
}
/* 06 §11：live.currentNodeId 对应的事件行在左侧加一道 business 竖条（文字仍是主通道）。 */
.fs-log-event.current{box-shadow:inset 2px 0 0 var(--dsw-alias-state-business-primary)}
/* m10：「当前」文字徽标，不再只靠颜色竖条。 */
.fs-log-current-badge{
  flex:none;display:inline-flex;align-items:center;height:16px;padding:0 5px;
  border-radius:var(--dsw-radius-xs);font-size:12px;line-height:14px;font-weight:500;
  color:var(--dsw-alias-state-business-primary);
  background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent);
  box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-business-primary) 38%, transparent);
}
.fs-log-glyph{flex:none;width:12px;text-align:center;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.fs-log-ts{
  flex:none;font-family:var(--dsw-font-markdown-code-font-family);font-size:12px;line-height:16px;
  font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary);white-space:nowrap;
}
.fs-log-kind{
  flex:none;max-width:104px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:var(--dsw-font-markdown-code-font-family);font-size:12px;line-height:16px;
  color:var(--dsw-alias-label-secondary);
}
.fs-log-summary{
  flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);
}
.fs-log-pager{
  flex:none;display:flex;align-items:center;gap:6px;height:26px;padding:0 8px;
  border-top:1px solid var(--dsw-alias-border-l1);
}
.fs-log-page{
  flex:1;min-width:0;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;
}
.fs-log-mini{
  display:inline-flex;align-items:center;justify-content:center;height:24px;padding:0 8px;
  border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs);
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);
  font-family:inherit;font-size:12px;line-height:16px;white-space:nowrap;cursor:pointer;
}
.fs-log-mini:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.fs-log-mini:disabled{opacity:.45;cursor:not-allowed}
.fs-log-mini:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}

.fs-log-detail-wrap{flex:1;min-height:0;overflow:auto;padding:0 10px 8px}
.fs-log-detail-body{display:flex;flex-direction:column;gap:6px;min-width:0}
.fs-log-detail-meta{
  font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);
  word-break:break-word;
}
.fs-log-json{
  margin:0;max-height:86px;overflow:auto;padding:6px 8px;
  border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-xs);
  background:var(--dsw-alias-bg-layer-2);
  font-family:var(--dsw-font-markdown-code-font-family);font-size:12px;line-height:16px;
  color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;
}
.fs-log-ref,.fs-log-node-line{
  font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);word-break:break-word;
}
.fs-log-node{
  display:flex;flex-direction:column;gap:4px;padding:6px 8px;
  border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-xs);
  background:var(--dsw-alias-bg-base);
}
.fs-log-node-title{font-size:12px;line-height:16px;font-weight:500;color:var(--dsw-alias-label-primary)}
.fs-log-empty{
  display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:8px 10px;
  font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);
}

/* ══ 抽屉三档高度 / 区域折叠 / 节点运行详情（A + B）════════ */
/* 拉高：70vh（与 logdrawer 的 DRAWER_TALL_VH 同源）；全屏：fixed 占满视口，遮住画布。 */
.fs-log.zoom-tall{height:70vh;min-height:320px}
.fs-log.zoom-full{position:fixed;inset:0;z-index:1200;height:auto;max-height:none;transition:none}
.fs-log.zoom-tall .fs-log-grid{grid-template-columns:230px minmax(0,1fr) 360px}
.fs-log.zoom-full .fs-log-grid{grid-template-columns:260px minmax(0,1fr) 440px}
/* 头部与指标区固定，只有事件列表 / 详情各自滚动（拉高、全屏都不破版）。 */
.fs-log.zoom-tall .fs-log-body,.fs-log.zoom-full .fs-log-body{overflow:hidden}
.fs-log.zoom-full .fs-log-stats{min-height:58px}
.fs-log-region{flex:none;display:flex;flex-direction:column;min-width:0}
.fs-log-region-head{
  flex:none;display:flex;align-items:center;gap:8px;height:24px;padding:0 10px;
  border-top:1px solid var(--dsw-alias-border-l1);
  font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);
}
.fs-log-region-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fs-log-region-toggle{flex:none}
.fs-log-events-body{display:flex;flex-direction:column;flex:1;min-height:0;min-width:0}

/* 事件行里的节点名：B4 的「点节点名看运行详情」入口。 */
.fs-log-node-chip{
  flex:none;max-width:104px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  border:1px solid var(--dsw-alias-border-l1);background:transparent;border-radius:var(--dsw-radius-panel);
  color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:12px;line-height:14px;
  padding:1px 6px;cursor:pointer;
}
.fs-log-node-chip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.fs-log-node-chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}

/* 节点运行详情面板：状态用形状 + 文字，颜色只加速。 */
.fs-log-node-panel{display:flex;flex-direction:column;gap:6px;min-width:0;padding-bottom:6px}
.fs-log-node-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;min-width:0}
.fs-log-node-head-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.fs-log-node-name{
  font-size:14px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary);
  word-break:break-word;
}
.fs-log-node-sub{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);word-break:break-word}
.fs-log-node-head-side{flex:none;display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap;justify-content:flex-end}
.fs-log-node-state{
  font-size:12px;line-height:14px;padding:1px 6px;border-radius:var(--dsw-radius-panel);
  color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);white-space:nowrap;
}
.fs-log-node-state.success{
  color:var(--fs-r2-success);
  background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent);
}
.fs-log-node-state.error{
  color:var(--fs-r2-error);
  background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);
}
.fs-log-node-state.warn{
  color:var(--fs-r2-warn);
  background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent);
}
.fs-log-node-state.business{
  color:var(--dsw-alias-state-business-primary);
  background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);
}
/* B5：运行中指示 = 圆点 + 文字，不做无限动画；prefers-reduced-motion 已有全局兜底。 */
.fs-log-running{
  display:inline-flex;align-items:center;gap:4px;white-space:nowrap;
  font-size:12px;line-height:14px;color:var(--dsw-alias-state-business-primary);
}
.fs-log-live-dot{width:6px;height:6px;border-radius:var(--dsw-radius-panel);background:currentColor}
.fs-log-node-facts{
  display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;
  font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);
}
.fs-log-fact{white-space:nowrap}
/* 节点详情里的会话入口 / preset（0.10 R4/R5）：只做间距，不新增颜色语义。 */
.fs-log-session{flex:none}
.fs-log-preset{white-space:nowrap}
.fs-log-node-block{
  display:flex;flex-direction:column;gap:4px;min-width:0;padding:6px 8px;
  border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-xs);
  background:var(--dsw-alias-bg-layer-2);
}
.fs-log-node-block-title{
  display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;
  font-size:12px;line-height:16px;font-weight:500;color:var(--dsw-alias-label-primary);
}
.fs-log-node-block-hint{font-size:12px;line-height:16px;font-weight:400;color:var(--dsw-alias-label-tertiary)}
.fs-log-empty-inline{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);padding:2px 0}

/* 最近在做什么：整段文本换行，超长用「展开全文」进弹层，不靠 ellipsis 一刀切。 */
.fs-log-msg{display:flex;flex-direction:column;gap:2px;min-width:0;padding:4px 0;
  border-top:1px solid var(--dsw-alias-border-l1)}
.fs-log-msg:first-of-type{border-top:none;padding-top:0}
.fs-log-msg-meta{
  display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;
  font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);
}
.fs-log-msg-who{color:var(--dsw-alias-label-secondary);font-weight:500}
.fs-log-msg-time{font-family:var(--dsw-font-markdown-code-font-family);font-variant-numeric:tabular-nums}
.fs-log-msg-flag{color:var(--dsw-alias-state-warn-primary)}
.fs-log-msg-text{
  font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);
  white-space:pre-wrap;word-break:break-word;max-height:72px;overflow:hidden;
}
.fs-log-more{align-self:flex-start;margin-top:2px}

/* 最近工具调用：名字 + 参数摘要 + 结果状态 + 耗时。 */
.fs-log-tool{display:flex;flex-direction:column;gap:2px;min-width:0;padding:4px 0;
  border-top:1px solid var(--dsw-alias-border-l1)}
.fs-log-tool:first-of-type{border-top:none;padding-top:0}
.fs-log-tool-line{
  display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;
  font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);
}
.fs-log-tool-name{
  font-family:var(--dsw-font-markdown-code-font-family);font-weight:500;
  color:var(--dsw-alias-label-primary);word-break:break-all;
}
.fs-log-tool-ok{font-weight:500}
.fs-log-tool-ok.ok{color:var(--fs-r2-success)}
.fs-log-tool-ok.bad{color:var(--fs-r2-error)}
.fs-log-tool-ok.unknown{color:var(--dsw-alias-label-tertiary)}
.fs-log-tool-time{
  font-family:var(--dsw-font-markdown-code-font-family);font-variant-numeric:tabular-nums;
  font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);
}
.fs-log-tool-args{
  font-family:var(--dsw-font-markdown-code-font-family);font-size:12px;line-height:16px;
  color:var(--dsw-alias-label-tertiary);white-space:pre-wrap;word-break:break-all;
  max-height:48px;overflow:hidden;
}

/* 节点会话可用工具（0.10 R6）：独立于「最近工具调用」，不复用 .fs-log-tool。 */
.fs-log-available-tools{min-width:0}
.fs-log-tools-summary{
  font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary);
  cursor:pointer;list-style:revert;
}
.fs-log-tools-summary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.fs-log-tool-chips{display:flex;flex-wrap:wrap;gap:4px;padding:6px 0 0}
.fs-log-tool-chip{
  display:inline-flex;align-items:center;min-height:18px;padding:0 6px;
  border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-interactive-bg-hover);
  font-family:var(--dsw-font-markdown-code-font-family);font-size:12px;line-height:16px;
  color:var(--dsw-alias-label-secondary);word-break:break-all;
}
.fs-log-tools-empty{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);padding:2px 0}

/* 成员最近活动 / 已写产物。 */
.fs-log-member{display:flex;flex-direction:column;gap:2px;min-width:0;padding:4px 0;
  border-top:1px solid var(--dsw-alias-border-l1)}
.fs-log-member:first-of-type{border-top:none;padding-top:0}
.fs-log-member-line{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;font-size:12px;line-height:16px}
.fs-log-member-name{color:var(--dsw-alias-label-primary);font-weight:500}
.fs-log-member-role{color:var(--dsw-alias-label-tertiary)}
.fs-log-member-state{color:var(--dsw-alias-label-secondary)}
.fs-log-member-last{
  font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);
  word-break:break-word;max-height:36px;overflow:hidden;
}
.fs-log-member-time{
  font-family:var(--dsw-font-markdown-code-font-family);font-variant-numeric:tabular-nums;
  font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);
}
.fs-log-artifact{display:flex;flex-direction:column;gap:1px;min-width:0;padding:3px 0}
.fs-log-artifact-path{
  font-family:var(--dsw-font-markdown-code-font-family);font-size:12px;line-height:16px;
  color:var(--dsw-alias-label-primary);word-break:break-all;
}
.fs-log-artifact-meta{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.fs-log-node-actions{display:flex;flex-wrap:wrap;gap:4px}

/* B6：失败原因不再只显示一个红点。 */
.fs-log-failure{
  display:flex;flex-direction:column;gap:2px;padding:6px 8px;
  border-radius:var(--dsw-radius-xs);
  border:1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, transparent);
  background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);
}
.fs-log-failure-title{font-size:12px;line-height:16px;font-weight:500;color:var(--fs-r2-error)}
.fs-log-failure-text{
  font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);
  white-space:pre-wrap;word-break:break-word;
}

/* 长文本弹层（A2）：可滚动、可复制、Esc 关闭。 */
.fs-log-overlay{
  position:fixed;inset:0;z-index:1300;display:flex;align-items:center;justify-content:center;padding:24px;
  background:color-mix(in srgb, var(--dsw-alias-label-primary) 32%, transparent);
}
.fs-log-overlay-panel{
  display:flex;flex-direction:column;width:min(760px,100%);max-height:min(80vh,720px);overflow:hidden;
  background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);
  border-radius:var(--dsw-radius-md);outline:none;
}
.fs-log-overlay-panel:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.fs-log-overlay-head{
  flex:none;display:flex;align-items:center;justify-content:space-between;gap:12px;
  padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);
}
.fs-log-overlay-title{
  min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:14px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary);
}
.fs-log-overlay-actions{flex:none;display:flex;gap:4px}
.fs-log-overlay-text{
  flex:1;min-height:0;overflow:auto;margin:0;padding:12px 14px;
  font-family:var(--dsw-font-markdown-code-font-family);font-size:12px;line-height:20px;
  color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;
  user-select:text;
}

/* 暗色只调加速识别用的 tint，信息仍靠文字与形状；不写 hex。 */
body[data-ds-dark-theme] .fs-log-event.active,
body[data-ds-dark-theme] .fs-log-event[aria-selected="true"]{
  background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 16%, transparent);
}

@media (max-width:1100px){
  .fs-log-grid{grid-template-columns:180px minmax(0,1fr) 240px}
}
@media (max-width:900px){
  .fs-log-breakdown{display:none}
}
/* A3：窄屏（<720px）三栏退化为单列——run 列表 / 事件流 / 详情纵向排列，各自可滚。 */
@media (max-width:720px){
  .fs-log.zoom-tall{height:78vh}
  .fs-log .fs-log-grid,
  .fs-log.zoom-tall .fs-log-grid,
  .fs-log.zoom-full .fs-log-grid{
    grid-template-columns:minmax(0,1fr);
    grid-auto-rows:minmax(0,auto);
    overflow-y:auto;
  }
  .fs-log-col{min-height:180px}
  .fs-log-col + .fs-log-col{border-left:none;border-top:1px solid var(--dsw-alias-border-l1)}
  .fs-log-event-list{max-height:52vh}
  .fs-log-node-head{flex-direction:column;gap:4px}
  .fs-log-node-head-side{justify-content:flex-start}
  .fs-log-overlay{padding:12px}
  /* 窄屏头行允许换行：三档按钮 + 刷新 / 导出 / 复制 / 收起不互相挤掉。 */
  .fs-log.open .fs-log-bar-wrap,
  .fs-log.zoom-tall .fs-log-bar-wrap,
  .fs-log.zoom-full .fs-log-bar-wrap{flex-wrap:wrap;height:auto;min-height:40px;padding-bottom:4px}
  .fs-log-actions-wrap{flex-wrap:wrap;justify-content:flex-end}
  .fs-log-zoom-raise,.fs-log-zoom-full,.fs-log-zoom-restore{padding-left:4px;padding-right:4px}
}


/* ══ 0.13.3 步骤 5：BPMN 页面（定义 / 实例 / 待办 / 事件）══════════════ */
.fs-bpmn-page{display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0}
.fs-bpmn-top{
  display:flex;align-items:center;gap:12px;flex:none;min-height:48px;padding:0 12px;
  background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1);
}
.fs-bpmn-top-title{display:flex;flex-direction:column;justify-content:center;min-width:0;gap:0}
.fs-bpmn-top-title strong{font-size:14px;line-height:22px;font-weight:600;white-space:nowrap}
.fs-bpmn-toolbar{display:flex;align-items:center;gap:4px;flex:1;min-width:0;justify-content:flex-end;flex-wrap:wrap}
.fs-bpmn-sep{flex:none;width:1px;height:20px;margin:0 4px;background:var(--dsw-alias-border-l1)}
.fs-bpmn-save-state{
  flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);
  font-variant-numeric:tabular-nums;padding:0 4px;white-space:nowrap;
}
.fs-bpmn-import{position:relative;overflow:hidden;cursor:pointer}
.fs-bpmn-import-input{position:absolute;inset:0;opacity:0;width:100%;height:100%;cursor:pointer;font-size:0}
.fs-bpmn-template{
  height:28px;max-width:170px;padding:0 6px;border-radius:var(--dsw-radius-sm);
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;
}
.fs-bpmn-notice{
  display:flex;align-items:center;gap:8px;flex:none;padding:6px 12px;font-size:12px;line-height:18px;
  border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-secondary);
}
.fs-bpmn-notice.error{color:var(--fs-r2-error);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, var(--dsw-alias-bg-base))}
.fs-bpmn-notice.warn{color:var(--fs-r2-warn);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, var(--dsw-alias-bg-base))}
.fs-bpmn-notice.success{color:var(--fs-r2-success)}
.fs-bpmn-main{flex:1;display:flex;min-height:0;min-width:0;overflow:hidden}

/* ── 左：定义列表 ─────────────────────────────────────────────── */
.fs-def-list{
  flex:none;width:250px;min-width:0;display:flex;flex-direction:column;min-height:0;
  border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);
}
.fs-def-head{display:flex;flex-direction:column;gap:6px;padding:10px 10px 4px;flex:none}
.fs-def-title{font-size:13px;line-height:20px}
.fs-def-actions{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.fs-def-import{position:relative;overflow:hidden;cursor:pointer}
.fs-def-import-input{position:absolute;inset:0;opacity:0;width:100%;height:100%;cursor:pointer;font-size:0}
.fs-def-template{
  height:24px;max-width:118px;padding:0 4px;border-radius:var(--dsw-radius-sm);
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;
}
.fs-def-list-tools{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:2px 10px 6px;flex:none}
.fs-def-count{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.fs-def-empty{padding:20px 12px;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary);margin:0}
.fs-def-rows{list-style:none;margin:0;padding:0 8px 12px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;flex:1;min-height:0}
.fs-def-row{
  display:flex;flex-direction:column;align-items:flex-start;gap:0;width:100%;padding:6px 8px;
  border:1px solid transparent;border-radius:var(--dsw-radius-sm);background:transparent;
  color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;font-family:inherit;
}
.fs-def-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.fs-def-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.fs-def-row.active{background:var(--dsw-alias-bg-base);border-color:var(--dsw-alias-border-l3);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}
.fs-def-row-name{font-size:13px;line-height:18px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fs-def-row-meta{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.fs-def-row-sub{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ── 中：画布 ─────────────────────────────────────────────────── */
.fs-bpmn-center{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--dsw-alias-bg-base)}
.fs-bpmn-viewhead{
  display:flex;align-items:center;gap:8px;flex:none;min-height:36px;padding:0 10px;
  border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);
  overflow:hidden;white-space:nowrap;
}
.fs-view-title{font-size:13px;line-height:20px;font-weight:600;overflow:hidden;text-overflow:ellipsis;max-width:36%}
.fs-view-name{
  width:190px;min-width:100px;height:24px;padding:0 6px;border-radius:var(--dsw-radius-sm);
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;
}
.fs-view-name:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.fs-view-version{
  height:24px;max-width:130px;padding:0 4px;border-radius:var(--dsw-radius-sm);
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;
}
.fs-view-meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.fs-view-badge{
  font-size:12px;line-height:18px;padding:0 6px;border-radius:calc(var(--dsw-radius-sm) - 2px);
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base);
}
.fs-view-badge.warn{color:var(--fs-r2-warn);border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent)}
.fs-status-chip{
  flex:none;font-size:12px;line-height:18px;padding:0 6px;border-radius:calc(var(--dsw-radius-sm) - 2px);
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base);
  font-variant-numeric:tabular-nums;
}
.fs-status-chip.business{color:var(--fs-r2-business);border-color:color-mix(in srgb, var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)) 45%, transparent)}
.fs-status-chip.success{color:var(--fs-r2-success);border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent)}
.fs-status-chip.warn{color:var(--fs-r2-warn);border-color:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 45%, transparent)}
.fs-status-chip.error{color:var(--fs-r2-error);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent)}
.fs-bpmn-canvas-main{flex:1;min-height:0;min-width:0;display:flex;flex-direction:column}
.fs-bpmn-canvas-main.fs-bpmn-canvas{width:100%;height:100%}

/* ── 右：实例 / 待办 ──────────────────────────────────────────── */
.fs-instance-panel{
  flex:none;width:340px;min-width:0;display:flex;flex-direction:column;min-height:0;
  border-left:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);
}
.fs-instance-head{display:flex;align-items:center;justify-content:space-between;gap:6px;flex:none;padding:10px 10px 6px}
.fs-instance-head strong{font-size:13px;line-height:20px}
.fs-instance-empty{padding:10px 12px;margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.fs-instance-rows{list-style:none;margin:0;padding:0 8px 8px;display:flex;flex-direction:column;gap:2px;max-height:200px;overflow-y:auto;flex:none}
.fs-instance-row{
  display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 6px;width:100%;padding:6px 8px;
  border:1px solid transparent;border-radius:var(--dsw-radius-sm);background:transparent;
  color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;font-family:inherit;
}
.fs-instance-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.fs-instance-row.active{background:var(--dsw-alias-bg-base);border-color:var(--dsw-alias-border-l3)}
.fs-instance-id{font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fs-instance-meta{grid-column:1 / -1;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fs-instance-pending{grid-column:1 / -1;font-size:12px;line-height:16px;color:var(--fs-r2-warn)}
.fs-instance-detail{
  flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:8px;
  padding:8px 10px 12px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);
}
.fs-instance-detail-empty{padding:10px 12px;margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.fs-instance-title{display:flex;align-items:center;gap:6px;min-width:0}
.fs-instance-title strong{font-size:13px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fs-instance-facts{display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 8px;margin:0;font-size:12px;line-height:18px}
.fs-instance-facts > div{display:contents}
.fs-instance-facts dt{color:var(--dsw-alias-label-tertiary)}
.fs-instance-facts dd{margin:0;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis}
.fs-instance-error{
  border:1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent);
  border-radius:var(--dsw-radius-sm);padding:6px 8px;background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 7%, transparent);
  font-size:12px;line-height:18px;color:var(--fs-r2-error);
}
.fs-instance-error strong{display:block;font-size:12px}
.fs-instance-error p{margin:2px 0 0;word-break:break-word}
.fs-instance-actions{display:flex;gap:6px;flex-wrap:wrap}
.fs-task-title{margin:2px 0 0;font-size:13px;line-height:20px}
.fs-task-empty{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.fs-task-list{display:flex;flex-direction:column;gap:8px}
.fs-task{
  display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:var(--dsw-radius-sm);
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);
}
.fs-task.busy{opacity:.75}
.fs-task-head{display:flex;align-items:center;justify-content:space-between;gap:6px}
.fs-task-name{font-size:13px;line-height:18px}
.fs-task-id{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:55%}
.fs-task-since,.fs-task-exec{margin:0;font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);word-break:break-all}
.fs-task-field{display:flex;flex-direction:column;gap:2px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.fs-task-payload,.fs-task-decided-by{
  width:100%;padding:4px 6px;border-radius:calc(var(--dsw-radius-sm) - 2px);
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-markdown-code-font-family, monospace);
  font-size:12px;line-height:18px;resize:vertical;min-height:28px;
}
.fs-task-decided-by{font-family:inherit}
.fs-task-payload:focus,.fs-task-decided-by:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.fs-task-error{margin:0;font-size:12px;line-height:16px;color:var(--fs-r2-error)}
.fs-task-submit{align-self:flex-start}

/* ── 底：实例事件抽屉 ─────────────────────────────────────────── */
.fs-event-drawer{
  flex:none;display:flex;flex-direction:column;min-width:0;
  border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);
}
.fs-event-bar{display:flex;align-items:center;gap:8px;height:40px;padding:0 10px;flex:none}
.fs-event-toggle{
  display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 8px;border:1px solid transparent;
  border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);
  cursor:pointer;font-family:inherit;font-size:13px;
}
.fs-event-toggle:hover{background:var(--dsw-alias-interactive-bg-hover)}
.fs-event-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.fs-event-caret{font-size:10px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.fs-event-count{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.fs-event-cursor{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.fs-event-error{font-size:12px;line-height:18px;color:var(--fs-r2-error);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fs-event-body{height:240px;min-height:120px;overflow-y:auto;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.fs-event-empty{margin:0;padding:24px 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.fs-event-rows{list-style:none;margin:0;padding:4px 0}
.fs-event-row{
  display:grid;grid-template-columns:56px 72px 96px minmax(0,1fr);gap:6px;align-items:center;width:100%;
  padding:3px 10px;border:0;border-left:2px solid transparent;background:transparent;
  color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;font-family:inherit;
  font-size:12px;line-height:18px;
}
.fs-event-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.fs-event-row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.fs-event-row.selected{border-left-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, transparent)}
.fs-event-row.unknown{color:var(--dsw-alias-label-tertiary);font-style:italic}
.fs-event-seq{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}
.fs-event-time{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}
.fs-event-kind{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fs-event-summary{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}

/* ── 右：实例工作区 / worktree 清理（0.13.8）──────────────────── */
.fs-instance-extras{
  flex:none;border-top:1px solid var(--dsw-alias-border-l1);
  max-height:300px;overflow-y:auto;background:var(--dsw-alias-bg-layer-1);
}
.fs-wt{display:flex;flex-direction:column;gap:6px;padding:8px 10px 10px;font-size:12px;line-height:18px}
.fs-wt-head{display:flex;align-items:center;justify-content:space-between;gap:6px}
.fs-wt-head strong{font-size:13px;line-height:20px}
.fs-wt-empty{margin:0;color:var(--dsw-alias-label-tertiary);word-break:break-word}
.fs-wt-note{margin:0;color:var(--dsw-alias-label-tertiary);word-break:break-word}
.fs-wt-body{display:flex;flex-direction:column;gap:6px}
.fs-wt-facts{display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 8px;margin:0}
.fs-wt-facts > div{display:contents}
.fs-wt-facts dt{color:var(--dsw-alias-label-tertiary)}
.fs-wt-facts dd{margin:0;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fs-wt-badges{display:flex;flex-wrap:wrap;gap:4px}
.fs-wt-reasons{margin:0;padding-left:16px;color:var(--fs-r2-warn);word-break:break-word}
.fs-wt-blocked{
  margin:0;padding:4px 6px;color:var(--fs-r2-warn);
  border:1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 38%, transparent);
  border-radius:var(--dsw-radius-sm);
  background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent);
}
.fs-wt-actions{display:flex;gap:6px;flex-wrap:wrap}
.fs-wt-confirm{
  display:flex;flex-direction:column;gap:6px;padding:6px 8px;
  border:1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent);
  border-radius:var(--dsw-radius-sm);
  background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 6%, transparent);
}
.fs-wt-danger{margin:0;color:var(--fs-r2-error);word-break:break-word}
.fs-wt-check{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary)}
.fs-wt-error{
  padding:6px 8px;color:var(--fs-r2-error);
  border:1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent);
  border-radius:var(--dsw-radius-sm);
  background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 7%, transparent);
  word-break:break-word;
}
.fs-wt-prune-head{
  display:flex;align-items:center;gap:6px;flex-wrap:wrap;
  border-top:1px solid var(--dsw-alias-border-l1);padding-top:6px;
}
.fs-wt-prune{display:flex;flex-direction:column;gap:6px}
.fs-wt-rows{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.fs-wt-row{
  display:flex;flex-direction:column;gap:0;padding:4px 6px;
  border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-base);
}
.fs-wt-row-id{color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fs-wt-row-meta{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.fs-wt-row-path{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fs-wt-plan{display:flex;flex-direction:column;gap:6px}
.fs-wt-hash{margin:0;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.fs-wt-hash code{font-family:var(--dsw-font-markdown-code-font-family, monospace);font-size:11px}

/* ── 右：实例消息 / 收件箱（0.13.10）──────────────────────────── */
.fs-inbox{display:flex;flex-direction:column;gap:6px;padding:8px 10px 10px;font-size:12px;line-height:18px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.fs-inbox-head{display:flex;align-items:center;justify-content:space-between;gap:6px}
.fs-inbox-head strong{font-size:13px;line-height:20px}
.fs-inbox-empty{margin:0;color:var(--dsw-alias-label-tertiary);word-break:break-word}
.fs-inbox-error{
  margin:0;padding:4px 6px;color:var(--fs-r2-error);
  border:1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent);
  border-radius:var(--dsw-radius-sm);
  background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 7%, transparent);
  word-break:break-word;
}
.fs-inbox-rows{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;max-height:240px;overflow-y:auto}
.fs-inbox-row{
  display:flex;flex-direction:column;gap:2px;padding:4px 6px;
  border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-base);
}
.fs-inbox-row-head{display:flex;align-items:center;gap:6px;min-width:0}
.fs-inbox-row-id{color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.fs-inbox-row-time{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none}
.fs-inbox-row-target{color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fs-inbox-preview{margin:0;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.fs-inbox-body-view{display:flex;flex-direction:column;gap:4px}
.fs-inbox-body-text{
  margin:0;padding:6px 8px;max-height:200px;overflow:auto;white-space:pre-wrap;word-break:break-word;
  font-family:var(--dsw-font-markdown-code-font-family, monospace);font-size:11px;line-height:16px;
  background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);
}
.fs-inbox-compose{display:flex;flex-direction:column;gap:4px}
.fs-inbox-hint{margin:0;color:var(--dsw-alias-label-tertiary);word-break:break-word}
.fs-inbox-target{
  height:26px;padding:0 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;
}
.fs-inbox-draft{
  min-height:52px;padding:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);
  background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);
  font-family:inherit;font-size:12px;line-height:18px;resize:vertical;
}
.fs-inbox-compose .fs-btn{align-self:flex-start}

.fs-metrics{display:flex;flex-direction:column;gap:6px;padding:8px 10px 10px;font-size:12px;line-height:18px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.fs-metrics-head{display:flex;align-items:center;justify-content:space-between;gap:6px}
.fs-metrics-head strong{font-size:13px;line-height:20px}
.fs-metrics-empty{margin:0;color:var(--dsw-alias-label-tertiary);word-break:break-word}
.fs-metrics-note{margin:0;color:var(--dsw-alias-label-tertiary);word-break:break-word}
.fs-metrics-body{display:flex;flex-direction:column;gap:6px}
.fs-metrics-facts{display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 8px;margin:0}
.fs-metrics-facts > div{display:contents}
.fs-metrics-facts dt{color:var(--dsw-alias-label-tertiary)}
.fs-metrics-facts dd{margin:0;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}
.fs-metrics-badges{display:flex;flex-wrap:wrap;gap:4px}
.fs-metrics-reasons{margin:0;padding-left:16px;color:var(--fs-r2-warn);word-break:break-word}
.fs-metrics-error{margin:0;color:var(--fs-r2-error);word-break:break-word}
.fs-metrics-business{display:flex;gap:4px;flex-wrap:wrap;align-items:baseline}
.fs-metrics-business code{font-family:var(--dsw-font-markdown-code-font-family, monospace);font-size:11px;overflow-wrap:anywhere}
.fs-metrics-groups{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.fs-metrics-groups li{display:flex;gap:6px;align-items:baseline;min-width:0}
.fs-metrics-day{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.fs-metrics-groups-meta{color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

@media (max-width:980px){
  .fs-instance-panel{width:290px}
  .fs-def-list{width:210px}
}
@media (max-width:760px){
  .fs-bpmn-main{flex-direction:column;overflow-y:auto}
  .fs-def-list{width:100%;max-height:180px;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l1)}
  .fs-instance-panel{width:100%;max-height:340px;border-left:0;border-top:1px solid var(--dsw-alias-border-l1)}
  .fs-bpmn-center{min-height:360px}
  .fs-event-row{grid-template-columns:44px 64px minmax(0,1fr)}
  .fs-event-kind{display:none}
}

@media (prefers-reduced-motion: reduce){
  .fs-root *{transition:none !important;animation:none !important}
}
`
