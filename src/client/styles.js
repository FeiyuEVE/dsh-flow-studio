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


.fs-sub{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary);padding-left:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

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

.fs-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}

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
.fs-inbox-row-focus{
  border-color:var(--dsw-alias-state-business-primary);
  box-shadow:0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, transparent);
}
.fs-inbox-total{margin:0;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.fs-inbox-mode{display:flex;gap:4px}
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
.fs-evidence{display:flex;flex-direction:column;gap:6px;padding:8px 10px 10px;font-size:12px;line-height:18px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.fs-evidence-head{display:flex;align-items:center;gap:6px}
.fs-evidence-head strong{font-size:13px;line-height:20px}
.fs-evidence-head .fs-evidence-note{margin-left:auto}
.fs-evidence-head button{margin-left:6px}
.fs-evidence-empty{margin:0;color:var(--dsw-alias-label-tertiary);word-break:break-word}
.fs-evidence-note{margin:0;color:var(--dsw-alias-label-tertiary);word-break:break-word}
.fs-evidence-body{display:flex;flex-direction:column;gap:6px}
.fs-evidence-badges{display:flex;flex-wrap:wrap;gap:4px}
.fs-evidence-badge{display:inline-flex;align-items:center;min-height:18px;padding:0 8px;border-radius:var(--dsw-radius-panel);font-size:12px;line-height:14px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2)}
.fs-evidence-badge.verified{color:var(--fs-r2-success, var(--dsw-alias-state-success-primary));background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--fs-r1-success, var(--dsw-alias-state-success-primary)) 35%, transparent)}
.fs-evidence-badge.warn{color:var(--fs-r2-warn, var(--dsw-alias-state-warn-primary));background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent)}
.fs-evidence-badge.stub{color:var(--fs-r2-warn, var(--dsw-alias-state-warn-primary));background:transparent;box-shadow:inset 0 0 0 1px color-mix(in srgb, var(--fs-r1-warn, var(--dsw-alias-state-warn-primary)) 60%, transparent)}
.fs-evidence-facts{display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 8px;margin:0}
.fs-evidence-facts > div{display:contents}
.fs-evidence-facts dt{color:var(--dsw-alias-label-tertiary)}
.fs-evidence-facts dd{margin:0;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}
.fs-evidence-reasons{margin:0;padding-left:16px;color:var(--fs-r2-warn);word-break:break-word}
.fs-evidence-error{margin:0;color:var(--fs-r2-error);word-break:break-word}
.fs-evidence-block{display:flex;flex-direction:column;gap:4px;min-width:0}
.fs-evidence-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;min-width:0}
.fs-evidence-item{display:flex;flex-direction:column;gap:2px;padding:4px 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);min-width:0}
.fs-evidence-item-head{display:flex;align-items:baseline;gap:6px;min-width:0}
.fs-evidence-item-head strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fs-evidence-item-body{display:flex;align-items:baseline;gap:4px;flex-wrap:wrap;min-width:0}
.fs-evidence-item-body code{font-family:var(--dsw-font-markdown-code-font-family, monospace);font-size:11px;overflow-wrap:anywhere}
.fs-evidence-meta{color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.fs-evidence-refs{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:1px;color:var(--dsw-alias-label-secondary);min-width:0}
.fs-evidence-refs code{font-family:var(--dsw-font-markdown-code-font-family, monospace);font-size:11px;overflow-wrap:anywhere}

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

/* 暗色主题：页面底色在暗色下再压一档，避免大面积纯色发灰。 */
body[data-ds-dark-theme] .fs-bpmn-page{
  background-color:color-mix(in srgb, var(--dsw-alias-bg-base) 96%, var(--dsw-alias-label-primary));
}

@media (prefers-reduced-motion: reduce){
  .fs-root *{transition:none !important;animation:none !important}
}
`
