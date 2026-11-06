/**
 * 左侧流程列表：新建 / 打开 / 删除。
 *
 * @module @feiyueve/dsh-flow-studio/client/flowlist
 */

import { h } from './runtime.js'
import { PlusIcon } from './icons.js'

function relativeTime(iso) {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return ''
  const diff = Date.now() - time
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return new Date(time).toLocaleDateString()
}

export function FlowList({ flows, activeId, onOpen, onCreate, onDelete, busy }) {
  return h('div', { className: 'fs-flows' },
    h('div', { className: 'fs-flows-head' },
      h('span', null, `流程模板 · ${flows.length}`),
      h('button', {
        type: 'button',
        className: 'fs-btn ghost sm',
        title: '新建流程',
        disabled: busy,
        onClick: onCreate,
      }, h(PlusIcon, null), '新建')),
    h('div', { className: 'fs-flows-list' },
      flows.length === 0
        ? h('div', { className: 'fs-empty' }, '还没有流程模板')
        : flows.map(item => h('div', {
          key: item.id,
          className: `fs-flow-item${item.id === activeId ? ' active' : ''}`,
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
          `${item.nodeCount} 节点`,
          item.rejectCount > 0 ? ` · ${item.rejectCount} 打回` : '',
          item.updatedAt ? ` · ${relativeTime(item.updatedAt)}` : ''),
        item.id === activeId
          ? h('div', { style: { display: 'flex', gap: 6, marginTop: 4 } },
            h('button', {
              type: 'button',
              className: 'fs-btn ghost sm',
              onClick: event => {
                event.stopPropagation()
                onDelete(item.id)
              },
            }, '删除'))
          : null)))
  )
}
