/**
 * 左侧流程模板列表：新建 / 打开 / 删除 / 折叠。
 *
 * @module @feiyueve/dsh-flow-studio/client/flowlist
 */

import { h } from './runtime.js'

function relativeTime(iso) {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return ''
  const diff = Date.now() - time
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' 分钟前'
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + ' 小时前'
  if (diff < 30 * 86_400_000) return Math.floor(diff / 86_400_000) + ' 天前'
  return new Date(time).toLocaleDateString()
}

export function FlowList({ flows, activeId, busy, collapsed, onToggle, onOpen, onCreate, onDelete }) {
  return h('aside', { className: 'fs-rail' + (collapsed ? ' collapsed' : '') },
    h('div', { className: 'fs-rail-head' },
      h('span', { className: 'fs-rail-label' }, '流程模板 · ' + flows.length),
      h('button', {
        type: 'button',
        className: 'fs-tool',
        title: collapsed ? '展开流程列表' : '收起流程列表',
        onClick: onToggle,
      }, collapsed ? '»' : '«')),
    h('button', {
      type: 'button',
      className: 'fs-btn fs-rail-new',
      style: { margin: '0 8px 8px' },
      disabled: busy,
      onClick: onCreate,
    }, '+ 新建'),
    h('div', { className: 'fs-rail-list' },
      flows.length === 0
        ? h('div', { className: 'fs-empty-panel' }, '还没有流程模板')
        : flows.map(item => h('div', {
          key: item.id,
          className: 'fs-flow' + (item.id === activeId ? ' active' : ''),
          role: 'button',
          tabIndex: 0,
          onClick: () => onOpen(item.id),
          onKeyDown: event => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onOpen(item.id)
            }
          },
        },
        h('div', { className: 'fs-flow-name', title: item.name }, item.name),
        h('div', { className: 'fs-flow-meta' },
          item.nodeCount + ' 节点 · ' + item.rejectCount + ' 打回' +
          (item.updatedAt ? ' · ' + relativeTime(item.updatedAt) : '')),
        item.id === activeId
          ? h('div', { className: 'fs-flow-actions' },
            h('button', {
              type: 'button',
              className: 'fs-btn ghost sm',
              onClick: event => {
                event.stopPropagation()
                onDelete(item.id)
              },
            }, '删除'))
          : null))))
}
