/**
 * 弹层：流转预览 + 校验问题清单。
 *
 * @module @feiyueve/dsh-flow-studio/client/dialogs
 */

import { EDGE_KIND, EXEC_MODE, NODE_KIND, describeFlow } from '../model.js'
import { h, rt } from './runtime.js'

export function Modal({ title, children, footer, onClose }) {
  const { useEffect } = rt.React
  useEffect(() => {
    const onKey = event => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return h('div', {
    className: 'fs-mask',
    onPointerDown: event => {
      if (event.target === event.currentTarget) onClose()
    },
  },
  h('div', { className: 'fs-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { className: 'fs-modal-head' },
      h('span', null, title),
      h('button', { type: 'button', className: 'fs-tool', onClick: onClose, title: '关闭' }, '✕')),
    h('div', { className: 'fs-modal-body' }, children),
    footer ? h('div', { className: 'fs-modal-foot' }, footer) : null))
}

export function PreviewDialog({ flow, onClose }) {
  const stages = flow.nodes.filter(node => node.kind === NODE_KIND.STAGE)
  const teamNodes = stages.filter(node => node.mode === EXEC_MODE.TEAM)
  const rejectEdges = flow.edges.filter(edge => edge.kind === EDGE_KIND.REJECT)
  return h(Modal, {
    title: '流转预览',
    onClose,
    footer: h('button', { type: 'button', className: 'fs-btn', onClick: onClose }, '关闭'),
  },
  h('div', { className: 'fs-hint' },
    stages.length + ' 个阶段 · ' + teamNodes.length + ' 个主从节点 · ' + rejectEdges.length + ' 条打回线'),
  h('pre', { className: 'fs-pre' }, describeFlow(flow)),
  h('div', { className: 'fs-hint' },
    '打回上限默认 2 轮，每个节点可单独设。这一版只保存模板，执行引擎还没接。'))
}

export function IssuesDialog({ validation, onSelect, onClose }) {
  const items = [
    ...validation.errors.map(item => ({ ...item, level: 'error' })),
    ...validation.warnings.map(item => ({ ...item, level: 'warning' })),
  ]
  return h(Modal, {
    title: '校验结果 · ' + validation.errors.length + ' 个错误 / ' + validation.warnings.length + ' 个提醒',
    onClose,
    footer: h('button', { type: 'button', className: 'fs-btn', onClick: onClose }, '关闭'),
  },
  items.length === 0
    ? h('div', { className: 'fs-empty-panel' }, '校验通过：结构完整，可以保存。')
    : items.map((item, index) => h('div', { key: index, className: 'fs-issue ' + item.level },
      h('span', { className: 'fs-issue-mark' }, item.level === 'error' ? '✕' : '!'),
      item.nodeId
        ? h('button', {
          type: 'button',
          className: 'fs-issue-link',
          onClick: () => {
            onSelect({ kind: 'node', id: item.nodeId })
            onClose()
          },
        }, item.message)
        : item.edgeId
          ? h('button', {
            type: 'button',
            className: 'fs-issue-link',
            onClick: () => {
              onSelect({ kind: 'edge', id: item.edgeId })
              onClose()
            },
          }, item.message)
          : h('span', null, item.message))))
}
