/**
 * 左侧导航：流程模板列表 + 运行记录（按工作区分组的只读列表）。
 *
 * 运行记录是 v0.7 §4.3 的「按工作区分组」：分组键是 `run.workspacePath`，
 * 没有就归到「未标注工作区」——旧数据整列退化成一个默认分组，不抛错、不白屏。
 * 详情头部只读展示 supervision（§7），不提供开关（开关走模型工具 / HTTP）。
 *
 * @module @feiyueve/dsh-flow-studio/client/flowlist
 */

import { runStatusOf, statusText } from './logdrawer.js'
import { h, rt } from './runtime.js'

/** 没有 workspacePath 的运行统一归到这个分组。 */
export const UNKNOWN_WORKSPACE = '未标注工作区'

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value) {
  return typeof value === 'string' ? value : ''
}

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

/** 兼容 `{runs}` / `{items}` / `{list}` / `{data:{runs}}` / 裸数组；坏值一律变空数组。 */
export function extractRunRows(payload) {
  if (Array.isArray(payload)) return payload.filter(isObject)
  if (!isObject(payload)) return []
  for (const key of ['runs', 'items', 'list']) {
    if (Array.isArray(payload[key])) return payload[key].filter(isObject)
  }
  if (isObject(payload.data)) return extractRunRows(payload.data)
  return []
}

/** 读 run 的工作区路径：优先 summary 的 `workspacePath`，退回 run.json 的 `workspace.path`。 */
export function workspacePathOf(run) {
  const direct = run && typeof run.workspacePath === 'string' ? run.workspacePath.trim() : ''
  if (direct !== '') return direct
  const workspace = run && isObject(run.workspace) ? run.workspace : null
  return workspace && typeof workspace.path === 'string' ? workspace.path.trim() : ''
}

/** 路径尾巴：取最后 1–2 段（240px 左栏放得下，又能区分同名目录）；空路径 → 未标注。 */
export function workspaceTail(path) {
  const raw = typeof path === 'string' ? path.trim() : ''
  if (raw === '') return UNKNOWN_WORKSPACE
  const parts = raw.replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean)
  if (parts.length === 0) return raw
  return parts.length === 1 ? parts[0] : parts.slice(-2).join('/')
}

/** 按 workspacePath 分组；保持 run 的原始顺序（Host 已按时间倒序）。 */
export function groupRunsByWorkspace(runs) {
  const list = Array.isArray(runs) ? runs.filter(isObject) : []
  const groups = new Map()
  for (const run of list) {
    const path = workspacePathOf(run)
    if (!groups.has(path)) {
      groups.set(path, {
        key: path,
        path,
        label: path === '' ? UNKNOWN_WORKSPACE : workspaceTail(path),
        runs: [],
      })
    }
    groups.get(path).runs.push(run)
  }
  return [...groups.values()]
}

/** 分组是否展开：显式点过的按记录，没点过的第一组默认展开、其余收起。 */
export function isGroupOpen(toggles, key, index) {
  return toggles && typeof toggles.has === 'function' && toggles.has(key)
    ? toggles.get(key) === true
    : index === 0
}

/** 切换后的展开表：以「当前实际展开态」为准，第一组默认展开时点一下也能收起。 */
export function nextGroupToggles(toggles, key, currentlyOpen) {
  const next = new Map(toggles || [])
  next.set(key, !currentlyOpen)
  return next
}

/** `run.worktree` / `run.worktreeEnabled` → `{ enabled, branch }`；字段缺失一律未启用。 */
export function worktreeOf(run) {
  const record = run && isObject(run.worktree) ? run.worktree : null
  const enabled = Boolean((run && run.worktreeEnabled === true) || (record && record.enabled === true))
  const branch = record && typeof record.branch === 'string' ? record.branch.trim() : ''
  return { enabled, branch }
}

/** 次数类字段：数字或数字字符串都收；坏值按 0（不编造唤醒记录）。 */
function countOf(value) {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0
}

/** supervision 只读视图；缺失 / 坏值一律 `enabled:false`（UI 显示「未开启」）。 */
export function supervisionOf(run) {
  const record = run && isObject(run.supervision) ? run.supervision : null
  return {
    present: record !== null,
    enabled: Boolean(record && record.enabled === true),
    nextDueAt: record && typeof record.nextDueAt === 'string' ? record.nextDueAt : '',
    wakes: record ? countOf(record.wakes) : 0,
    failures: record ? countOf(record.failures) : 0,
    reason: record && typeof record.reason === 'string' ? record.reason.trim() : '',
  }
}

const pad2 = value => String(value).padStart(2, '0')

/** `nextDueAt` → 本地时钟。当天只显示 HH:MM:SS，跨天带 MM-DD；解析不了就原样显示。 */
export function formatWakeAt(value) {
  const raw = text(value).trim()
  if (raw === '') return ''
  const time = Date.parse(raw)
  if (!Number.isFinite(time)) return raw
  const date = new Date(time)
  const clock = pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds())
  const now = new Date()
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()
  return sameDay ? clock : pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + clock
}

function SupervisionLine({ run }) {
  const supervision = supervisionOf(run)
  if (!supervision.enabled) {
    return h('div', { className: 'fs-run-sup' },
      h('div', null,
        h('span', { className: 'fs-run-sup-label' }, '监督'),
        h('span', null, '未开启')),
      // 降级关闭（连续唤醒失败等）也要把原因显示出来，不能只说「未开启」。
      supervision.reason === ''
        ? null
        : h('div', { className: 'fs-run-sup-reason' }, '关闭原因：' + supervision.reason))
  }
  const next = formatWakeAt(supervision.nextDueAt)
  return h('div', { className: 'fs-run-sup on' },
    h('div', null,
      h('span', { className: 'fs-run-sup-label' }, '监督'),
      h('span', null,
        '已开启 · 下次唤醒 ' + (next === '' ? '—' : next)
        + ' · 已唤醒 ' + supervision.wakes + ' 次'
        + ' · 失败 ' + supervision.failures + ' 次')),
    supervision.reason === ''
      ? null
      : h('div', { className: 'fs-run-sup-reason' }, '关闭原因：' + supervision.reason))
}

/** 运行详情头部：工作区 / worktree / supervision 都只读。 */
function RunDetail({ run, active }) {
  const path = workspacePathOf(run)
  const worktree = worktreeOf(run)
  const name = text(run.name) || text(run.id) || '未命名运行'
  return h('div', { className: 'fs-run-detail' + (active ? ' on' : ''), 'aria-label': '运行详情头部' },
    h('div', { className: 'fs-run-detail-name', title: text(run.id) || name }, name),
    h('div', { className: 'fs-run-detail-line', title: path === '' ? UNKNOWN_WORKSPACE : path },
      '工作区 · ' + (path === '' ? UNKNOWN_WORKSPACE : workspaceTail(path))),
    h('div', { className: 'fs-run-detail-line' },
      'worktree · ' + (worktree.enabled ? (worktree.branch === '' ? '已启用' : '⎇ ' + worktree.branch) : '未启用')),
    h(SupervisionLine, { run }))
}

function RunRow({ run, on, onFocus }) {
  const worktree = worktreeOf(run)
  const name = text(run.name) || text(run.id) || '未命名运行'
  const id = text(run.id)
  const titleParts = [name]
  if (id !== '' && id !== name) titleParts.push(id)
  if (worktree.enabled) {
    // 07 §4.3：worktree 行要在标题提示里写分支名；没有分支就只留标记。
    titleParts.push(worktree.branch === '' ? 'worktree 已启用' : 'worktree 分支 ' + worktree.branch)
  }
  return h('button', {
    type: 'button',
    className: 'fs-run' + (on ? ' on' : ''),
    title: titleParts.join(' · '),
    onClick: () => {
      if (typeof onFocus === 'function') onFocus(run)
    },
  },
  h('span', { className: 'fs-run-name' }, name),
  h('span', { className: 'fs-run-meta' },
    statusText(runStatusOf(run)),
    worktree.enabled
      ? h('span', {
        className: 'fs-run-wt',
        'aria-label': worktree.branch === '' ? 'worktree 已启用' : 'worktree 分支 ' + worktree.branch,
      }, ' · ⎇ worktree')
      : null))
}

function RunGroup({ group, open, onToggle, selectedRunId, onFocusRun }) {
  return h('div', { className: 'fs-rail-group' },
    h('button', {
      type: 'button',
      className: 'fs-rail-group-head',
      'aria-expanded': open ? 'true' : 'false',
      title: group.path === '' ? UNKNOWN_WORKSPACE : group.path,
      onClick: () => onToggle(group.key, open),
    },
    h('span', { className: 'fs-rail-caret', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
    h('span', { className: 'fs-rail-group-label' }, group.label),
    h('span', { className: 'fs-rail-count' }, String(group.runs.length))),
    open
      ? h('div', { className: 'fs-run-list' },
        group.runs.map((run, index) => h(RunRow, {
          key: text(run.id) || group.key + ':' + index,
          run,
          on: text(run.id) !== '' && text(run.id) === selectedRunId,
          onFocus: onFocusRun,
        })))
      : null)
}

export function FlowList({
  flows = [], activeId, busy, collapsed, onToggle, onOpen, onCreate, onDelete,
  // v0.7：运行记录。不传 runs 时保持旧行为（不渲染运行区），传入数组才显示。
  runs = null,
  selectedRunId = '',
  activeRunId = '',
  onFocusRun = null,
}) {
  const { useState } = rt.React
  // 显式点过的分组才记状态；没点过的第一组默认展开（其余收起）。
  const [groupToggles, setGroupToggles] = useState(() => new Map())
  const runRows = Array.isArray(runs) ? runs.filter(isObject) : null
  const groups = runRows === null ? [] : groupRunsByWorkspace(runRows)
  const selected = runRows === null
    ? null
    : runRows.find(run => text(run.id) !== '' && text(run.id) === selectedRunId)
      || runRows.find(run => text(run.id) !== '' && text(run.id) === activeRunId)
      || runRows[0]
      || null

  const toggleGroup = (key, currentlyOpen) => {
    setGroupToggles(previous => nextGroupToggles(previous, key, currentlyOpen))
  }

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
          : null))),
    runRows === null
      ? null
      : h('div', { className: 'fs-rail-runs' },
        h('div', { className: 'fs-rail-head fs-rail-subhead' },
          h('span', { className: 'fs-rail-label' }, '运行记录 · ' + runRows.length)),
        h('div', { className: 'fs-rail-runs-list' },
          runRows.length === 0
            ? h('div', { className: 'fs-empty-panel', style: { padding: '10px 8px' } }, '还没有运行记录')
            : h('div', null,
              selected ? h(RunDetail, { run: selected, active: text(selected.id) === activeRunId }) : null,
              groups.map((group, index) => h(RunGroup, {
                key: group.key === '' ? 'unknown-workspace' : group.key,
                group,
                open: isGroupOpen(groupToggles, group.key, index),
                onToggle: toggleGroup,
                selectedRunId,
                onFocusRun,
              }))))))
}
