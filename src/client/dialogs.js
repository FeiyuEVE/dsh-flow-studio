/**
 * 弹层：流转预览 + 校验问题清单。
 *
 * @module @feiyueve/dsh-flow-studio/client/dialogs
 */

import { EXEC_MODE, NODE_KIND, describeFlow } from '../model.js'
import { h } from './runtime.js'

export function Modal({ title, children, footer, onClose }) {
  return h('div', {
    className: 'fs-modal-mask',
    onPointerDown: event => {
      if (event.target === event.currentTarget) onClose()
    },
  },
  h('div', { className: 'fs-modal', role: 'dialog', 'aria-label': title },
    h('div', { className: 'fs-modal-head' },
      h('span', null, title),
      h('button', { type: 'button', className: 'fs-btn ghost sm', onClick: onClose, title: '关闭' }, '✕')),
    h('div', { className: 'fs-modal-body' }, children),
    footer ? h('div', { className: 'fs-modal-foot' }, footer) : null))
}

export function PreviewDialog({ flow, onClose }) {
  const stages = flow.nodes.filter(node => node.kind === NODE_KIND.STAGE)
  const teamNodes = stages.filter(node => node.mode === EXEC_MODE.TEAM)
  const rejectEdges = flow.edges.filter(edge => edge.kind === 'reject')
  return h(Modal, {
    title: '流转预览',
    onClose,
    footer: h('button', { type: 'button', className: 'fs-btn', onClick: onClose }, '关闭'),
  },
  h('div', { style: { fontSize: 11.5, color: 'var(--dsw-alias-label-secondary)' } },
    `${stages.length} 个阶段 · ${teamNodes.length} 个主从节点 · ${rejectEdges.length} 条打回线`),
  h('pre', { className: 'fs-pre' }, describeFlow(flow)),
  h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } },
    `打回最多 2 轮是默认值，每个节点可在检查器里单独设。这一版只保存模板，执行引擎还没接。`))
}

export function IssuesDialog({ validation, onSelect, onClose }) {
  const items = [
    ...validation.errors.map(item => ({ ...item, level: 'error' })),
    ...validation.warnings.map(item => ({ ...item, level: 'warning' })),
  ]
  return h(Modal, {
    title: `校验结果 · ${validation.errors.length} 个错误 / ${validation.warnings.length} 个提醒`,
    onClose,
    footer: h('button', { type: 'button', className: 'fs-btn', onClick: onClose }, '关闭'),
  },
  items.length === 0
    ? h('div', { className: 'fs-empty' }, '校验通过：结构完整，可以保存。')
    : items.map((item, index) => h('div', { key: index, className: `fs-issue ${item.level}` },
      h('span', { className: 'mark' }, item.level === 'error' ? '✕' : '!'),
      item.nodeId
        ? h('button', {
          type: 'button',
          onClick: () => {
            onSelect({ kind: 'node', id: item.nodeId })
            onClose()
          },
        }, item.message)
        : item.edgeId
          ? h('button', {
            type: 'button',
            onClick: () => {
              onSelect({ kind: 'edge', id: item.edgeId })
              onClose()
            },
          }, item.message)
          : h('span', null, item.message))))
}
