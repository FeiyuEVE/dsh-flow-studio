/**
 * 面板样式。全部走 --dsw-alias-* / --dsw-radius-* 主题变量，跟随全局亮/暗主题；
 * 只有画布网点与选中光晕用到 color-mix，没有写死的颜色值。
 *
 * 样式节点由页面组件渲染，面板卸载即随之移除，不在 document 上留东西。
 *
 * @module @feiyueve/dsh-flow-studio/client/styles
 */

export const CSS = `
.fs-root{
  display:flex;flex-direction:column;height:100%;width:100%;min-width:0;min-height:0;
  overflow:hidden;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);
  font-size:13px;line-height:1.55;font-family:var(--dsw-font-family,inherit);
}
.fs-root *{box-sizing:border-box}

/* ── 顶栏 ───────────────────────────────────────────── */
.fs-head{display:flex;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;min-height:52px}
.fs-head-title{display:flex;flex-direction:column;min-width:0;gap:1px}
.fs-title-input{
  border:none;background:transparent;color:var(--dsw-alias-label-primary);
  font-size:15px;font-weight:600;font-family:inherit;padding:1px 4px;border-radius:var(--dsw-radius-sm,8px);
  min-width:180px;width:100%;outline:none;
}
.fs-title-input:hover{background:var(--dsw-alias-bg-layer-2)}
.fs-title-input:focus{background:var(--dsw-alias-bg-layer-2);box-shadow:0 0 0 var(--dsw-focus-ring-width,2px) var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary))}
.fs-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);padding-left:5px}
.fs-head-spacer{flex:1}
.fs-save-state{font-size:11px;color:var(--dsw-alias-label-tertiary);display:flex;align-items:center;gap:5px}
.fs-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary)}
.fs-dot.dirty{background:var(--dsw-alias-state-warn-primary)}
.fs-dot.busy{background:var(--dsw-alias-brand-primary)}
.fs-dot.error{background:var(--dsw-alias-state-error-primary)}

/* ── 通用按钮 ───────────────────────────────────────── */
.fs-btn{
  display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 11px;
  border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,8px);
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
  font-size:12px;font-family:inherit;cursor:pointer;white-space:nowrap;transition:background .12s,border-color .12s;
}
.fs-btn:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.fs-btn:active{transform:translateY(.5px)}
.fs-btn:disabled{opacity:.45;cursor:not-allowed}
.fs-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.fs-btn.primary:hover{filter:brightness(1.06)}
.fs-btn.ghost{border-color:transparent;background:transparent}
.fs-btn.ghost:hover{background:var(--dsw-alias-bg-layer-2)}
.fs-btn.danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent)}
.fs-btn.danger:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
.fs-btn.sm{height:24px;padding:0 8px;font-size:11px}

/* ── 主体三栏 ───────────────────────────────────────── */
.fs-body{display:flex;flex:1;min-height:0;min-width:0}

/* 左侧流程列表 */
.fs-flows{width:186px;flex:none;border-right:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;min-height:0;background:var(--dsw-alias-bg-base)}
.fs-flows-head{display:flex;align-items:center;justify-content:space-between;padding:9px 12px 7px;font-size:11px;color:var(--dsw-alias-label-tertiary);letter-spacing:.02em}
.fs-flows-list{flex:1;overflow-y:auto;padding:0 8px 10px;display:flex;flex-direction:column;gap:2px}
.fs-flow-item{
  display:flex;flex-direction:column;gap:2px;padding:7px 9px;border-radius:var(--dsw-radius-sm,8px);
  cursor:pointer;border:1px solid transparent;min-width:0;
}
.fs-flow-item:hover{background:var(--dsw-alias-bg-layer-2)}
.fs-flow-item.active{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.fs-flow-name{font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fs-flow-meta{font-size:10px;color:var(--dsw-alias-label-tertiary)}

/* 中间画布 */
.fs-canvas{
  position:relative;flex:1;min-width:0;min-height:0;overflow:hidden;cursor:grab;touch-action:none;
  background-color:var(--dsw-alias-bg-base);
  background-image:radial-gradient(circle at 1px 1px,var(--dsw-alias-border-l1) 1px,transparent 0);
  background-size:22px 22px;
}
.fs-canvas.panning{cursor:grabbing}
.fs-world{position:absolute;left:0;top:0;transform-origin:0 0;width:0;height:0}
.fs-svg{position:absolute;left:0;top:0;overflow:visible;pointer-events:none;width:1px;height:1px}
.fs-node{
  position:absolute;display:flex;flex-direction:column;justify-content:center;gap:6px;
  padding:12px 15px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);
  background:var(--dsw-alias-bg-layer-1);cursor:move;user-select:none;
  transition:border-color .12s,box-shadow .12s;box-shadow:0 1px 2px rgba(0,0,0,.05);
}
.fs-node:hover{border-color:var(--dsw-alias-border-l4)}
.fs-node.selected{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 28%,transparent)}
.fs-node.kind-start{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,var(--dsw-alias-bg-layer-1));border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent)}
.fs-node.kind-end{background:var(--dsw-alias-bg-layer-2)}
.fs-node-title{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:6px}
.fs-node-meta{font-size:10px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fs-tag{font-size:9px;font-weight:500;padding:0 5px;height:15px;line-height:15px;border-radius:999px;flex:none}
.fs-tag.team{color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary));background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent)}
.fs-tag.reject{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 15%,transparent)}
.fs-tag.skill{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.fs-port{
  position:absolute;top:50%;width:11px;height:11px;margin-top:-5.5px;border-radius:50%;
  background:var(--dsw-alias-bg-base);border:2px solid var(--dsw-alias-border-l4);z-index:2;
}
.fs-port.in{left:-6.5px}
.fs-port.out{right:-6.5px;cursor:crosshair}
.fs-port.out:hover{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary)}
.fs-edge{fill:none;stroke:var(--dsw-alias-border-l4);stroke-width:1.6}
.fs-edge.reject{stroke:var(--dsw-alias-state-warn-primary);stroke-dasharray:5 4}
.fs-edge.selected{stroke:var(--dsw-alias-brand-primary);stroke-width:2.6}
.fs-edge-hit{fill:none;stroke:transparent;stroke-width:16;pointer-events:stroke;cursor:pointer}
.fs-edge-label{font-size:10px;fill:var(--dsw-alias-label-secondary);user-select:none}
.fs-edge-label.reject{fill:var(--dsw-alias-state-warn-primary)}
.fs-link-preview{fill:none;stroke:var(--dsw-alias-brand-primary);stroke-width:1.6;stroke-dasharray:4 3}

/* 画布角标控制 */
.fs-zoom{position:absolute;right:12px;bottom:12px;display:flex;align-items:center;gap:2px;padding:3px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-layer-1);box-shadow:0 2px 8px rgba(0,0,0,.06);z-index:5}
.fs-zoom button{width:26px;height:26px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-xs,4px);cursor:pointer;font-size:14px;line-height:1;font-family:inherit}
.fs-zoom button:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.fs-zoom-level{font-size:10px;color:var(--dsw-alias-label-tertiary);min-width:34px;text-align:center;font-variant-numeric:tabular-nums}

/* 右侧检查器 */
.fs-inspector{width:312px;flex:none;border-left:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;min-height:0;background:var(--dsw-alias-bg-base)}
.fs-inspector-head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px;font-weight:600;flex:none}
.fs-inspector-body{flex:1;overflow-y:auto;padding:12px 14px 24px;display:flex;flex-direction:column;gap:13px}
.fs-field{display:flex;flex-direction:column;gap:4px}
.fs-label{font-size:11px;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;justify-content:space-between;gap:6px}
.fs-label-hint{font-size:10px;color:var(--dsw-alias-label-tertiary);font-weight:400}
.fs-input,.fs-textarea,.fs-select{
  width:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,8px);
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
  font-family:inherit;font-size:12px;padding:6px 8px;outline:none;transition:border-color .12s;
}
.fs-input:focus,.fs-textarea:focus,.fs-select:focus{border-color:var(--dsw-alias-brand-primary)}
.fs-input::placeholder,.fs-textarea::placeholder{color:var(--dsw-alias-label-tertiary)}
.fs-textarea{resize:vertical;min-height:58px;line-height:1.6}
.fs-seg{display:flex;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,8px);overflow:hidden}
.fs-seg button{
  flex:1;height:28px;border:none;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);
  font-size:11.5px;font-family:inherit;cursor:pointer;transition:background .12s,color .12s;
}
.fs-seg button+button{border-left:1px solid var(--dsw-alias-border-l2)}
.fs-seg button.on{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary);font-weight:600}
.fs-empty{font-size:11px;color:var(--dsw-alias-label-tertiary);text-align:center;padding:26px 10px;line-height:1.7}
.fs-divider{height:1px;background:var(--dsw-alias-border-l1);margin:2px 0}

/* skills 多选 */
.fs-skills{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.fs-skills-filter{border:none;border-bottom:1px solid var(--dsw-alias-border-l1);border-radius:0;background:transparent;font-size:11px;padding:5px 8px;width:100%;outline:none;color:var(--dsw-alias-label-primary);font-family:inherit}
.fs-skills-filter::placeholder{color:var(--dsw-alias-label-tertiary)}
.fs-skills-list{max-height:132px;overflow-y:auto;padding:3px}
.fs-skill{display:flex;align-items:flex-start;gap:6px;padding:3px 5px;border-radius:var(--dsw-radius-xs,4px);cursor:pointer;font-size:11px}
.fs-skill:hover{background:var(--dsw-alias-bg-layer-2)}
.fs-skill input{margin:2px 0 0;accent-color:var(--dsw-alias-brand-primary);flex:none}
.fs-skill-name{font-weight:500;word-break:break-all}
.fs-skill-desc{font-size:10px;color:var(--dsw-alias-label-tertiary);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.fs-chips{display:flex;flex-wrap:wrap;gap:4px}
.fs-chip{display:inline-flex;align-items:center;gap:4px;font-size:10px;padding:1px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.fs-chip button{border:none;background:transparent;color:inherit;cursor:pointer;font-size:11px;padding:0 1px;line-height:1;opacity:.7}
.fs-chip button:hover{opacity:1;color:var(--dsw-alias-state-error-primary)}

/* 团队成员 */
.fs-member{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,8px);padding:8px;display:flex;flex-direction:column;gap:5px;background:var(--dsw-alias-bg-layer-1)}
.fs-member-head{display:flex;align-items:center;gap:6px}
.fs-member-idx{font-size:10px;color:var(--dsw-alias-label-tertiary);flex:none}

/* 底栏 / 校验 */
.fs-foot{display:flex;align-items:center;gap:10px;padding:0 16px;height:32px;flex:none;border-top:1px solid var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-base)}
.fs-foot b{font-weight:600;color:var(--dsw-alias-label-secondary)}
.fs-foot .ok{color:var(--dsw-alias-state-success-primary)}
.fs-foot .bad{color:var(--dsw-alias-state-error-primary)}
.fs-foot .warn{color:var(--dsw-alias-state-warn-primary)}
.fs-foot-spacer{flex:1}
.fs-issue-toggle{border:none;background:transparent;font:inherit;color:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:4px;padding:0}
.fs-issue-toggle:hover{color:var(--dsw-alias-label-primary)}

/* 弹层 */
.fs-modal-mask{position:absolute;inset:0;background:color-mix(in srgb,#000 32%,transparent);display:flex;align-items:center;justify-content:center;z-index:20;padding:24px}
.fs-modal{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xl,16px);box-shadow:0 12px 40px rgba(0,0,0,.24);display:flex;flex-direction:column;max-height:82%;width:min(620px,100%);overflow:hidden}
.fs-modal-head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:13px;font-weight:600;flex:none}
.fs-modal-body{flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.fs-pre{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;line-height:1.75;white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-bg-layer-2);border-radius:var(--dsw-radius-md,10px);padding:10px 12px;margin:0;color:var(--dsw-alias-label-secondary);max-height:300px;overflow:auto}
.fs-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l1);flex:none}
.fs-issue{display:flex;gap:7px;font-size:11.5px;line-height:1.6;align-items:flex-start}
.fs-issue .mark{flex:none;width:14px}
.fs-issue.error .mark{color:var(--dsw-alias-state-error-primary)}
.fs-issue.warning .mark{color:var(--dsw-alias-state-warn-primary)}
.fs-issue button{border:none;background:transparent;font:inherit;color:var(--dsw-alias-link,var(--dsw-alias-brand-primary));cursor:pointer;padding:0;text-align:left}
.fs-error-bar{padding:7px 16px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary);font-size:11.5px;flex:none;display:flex;align-items:center;gap:8px}
.fs-error-bar button{margin-left:auto;border:none;background:transparent;color:inherit;cursor:pointer;font-size:13px;line-height:1}
.fs-spinner{padding:36px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px}
`
