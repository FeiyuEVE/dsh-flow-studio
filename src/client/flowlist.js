/**
 * 左侧导航：流程模板列表 + 运行记录（按工作区分组的只读列表）。
 *
 * 运行记录是 v0.7 §4.3 的「按工作区分组」：分组键是 `run.workspacePath`，
 * 没有就归到「未标注工作区」——旧数据整列退化成一个默认分组，不抛错、不白屏。
 * 详情头部只读展示 supervision（§7）与节点自审状态（v0.8 §11.4），不提供开关
 *（开关走模型工具 / HTTP）。
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

/** v0.8 §11.4：节点自审状态的展示词表（颜色只落在 styles.js，文字走中文）。 */
const NODE_STATE_TEXT = { working: '进行中', done: '完成', blocked: '阻塞', failed: '失败' }
/** 节点多于这个数量时区块内部滚动（max-height + overflow），不撑爆 240px 左栏。 */
export const NODE_STATUS_SCROLL_AT = 6
/** 缺字段 / 空表 / 坏类型时的整块降级文案（老 run 走这里）。 */
export const NODE_STATUS_EMPTY_TEXT = '节点状态：暂无自审上报'

/** 进度：0..100 的有限数才收（取整夹取），坏值按 0——不编造进度。 */
function progressOf(value) {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  if (!Number.isFinite(number)) return 0
  return Math.min(100, Math.max(0, Math.floor(number)))
}

/** 单条自审记录归一化；`value` 不是对象 → null（坏输入不抛错）。 */
export function nodeStatusOf(value) {
  if (!isObject(value)) return null
  const state = text(value.state).trim().toLowerCase()
  const key = NODE_STATE_TEXT[state] ? state : 'working'
  const members = Array.isArray(value.members)
    ? value.members.filter(isObject).map(member => {
      const memberState = text(member.state).trim().toLowerCase()
      const memberKey = NODE_STATE_TEXT[memberState] ? memberState : 'working'
      return {
        name: text(member.name).trim() || '未命名成员',
        state: memberKey,
        label: NODE_STATE_TEXT[memberKey],
        note: text(member.note).trim(),
      }
    })
    : []
  const blockers = Array.isArray(value.blockers)
    ? value.blockers.map(item => text(item).trim()).filter(Boolean)
    : []
  const verdict = value.verdict === 'pass' || value.verdict === 'reject' ? value.verdict : ''
  return {
    state: key,
    label: NODE_STATE_TEXT[key],
    progress: progressOf(value.progress),
    summary: text(value.summary).trim(),
    members,
    blockers,
    verdict,
  }
}

/**
 * `run.nodeStatus` → `[{ nodeId, state, label, progress, members, blockers, verdict }]`。
 * 缺字段 / 空对象 / 坏类型一律空数组：0.7 及以前的老 run 整块走降级文案，不报错。
 */
export function nodeStatusEntries(run) {
  const table = run && isObject(run.nodeStatus) ? run.nodeStatus : null
  if (table === null) return []
  const entries = []
  for (const [nodeId, value] of Object.entries(table)) {
    const id = text(nodeId).trim()
    if (id === '') continue
    const status = nodeStatusOf(value)
    if (status !== null) entries.push({ nodeId: id, ...status })
  }
  return entries
}

/** 这个 run 是否有可展示的节点自审状态（页面据此决定要不要拉详情拿节点标题）。 */
export function hasNodeStatus(run) {
  return nodeStatusEntries(run).length > 0
}

/**
 * `GET /runs/<id>` 的 `nodes` → `nodeId → 标题`。
 * 契约是 `[{id, title}]`，这里同时容忍 `nodeId` 键与 `{ id: '标题' }` 映射；
 * 拿不到标题就返回空表，调用方退回显示 nodeId。
 */
export function nodeTitleMap(nodes) {
  const titles = new Map()
  const take = item => {
    if (!isObject(item)) return
    const id = text(item.id).trim() || text(item.nodeId).trim()
    if (id === '') return
    const title = text(item.title).trim() || text(item.name).trim()
    if (title !== '') titles.set(id, title)
  }
  if (Array.isArray(nodes)) {
    for (const item of nodes) take(item)
  } else if (isObject(nodes)) {
    for (const [id, value] of Object.entries(nodes)) {
      const key = text(id).trim()
      if (key === '') continue
      if (typeof value === 'string') {
        const title = value.trim()
        if (title !== '') titles.set(key, title)
      } else if (isObject(value)) {
        const title = text(value.title).trim() || text(value.name).trim()
        if (title !== '') titles.set(key, title)
      }
    }
  }
  return titles
}

/** 阻塞文案：最多列 3 条，更多用「等 N 条」收尾；没有阻塞返回空串。 */
export function blockersText(blockers) {
  const list = Array.isArray(blockers)
    ? blockers.map(item => text(item).trim()).filter(Boolean)
    : []
  if (list.length === 0) return ''
  const shown = list.slice(0, 3).join('、')
  return '阻塞：' + shown + (list.length > 3 ? ' 等 ' + list.length + ' 条' : '')
}

/** 单个节点一行：标题 + 状态徽标 + 进度条（只读，无按钮）。 */
function NodeStatusRow({ entry, title }) {
  return h('div', {
    className: 'fs-run-node',
    'data-state': entry.state,
    title: entry.summary === '' ? entry.nodeId : entry.nodeId + ' · ' + entry.summary,
  },
  h('div', { className: 'fs-run-node-head' },
    h('span', { className: 'fs-run-node-title' }, title),
    h('span', {
      className: 'fs-node-state ' + entry.state,
      title: '自审状态：' + entry.state,
    }, entry.label),
    entry.verdict === ''
      ? null
      : h('span', {
        className: 'fs-run-node-verdict ' + entry.verdict,
        title: '自审结论：' + entry.verdict,
      }, entry.verdict),
    h('span', { className: 'fs-run-node-pct' }, entry.progress + '%')),
  h('div', {
    className: 'fs-run-node-bar',
    role: 'progressbar',
    'aria-label': '节点进度',
    'aria-valuemin': 0,
    'aria-valuemax': 100,
    'aria-valuenow': entry.progress,
  }, h('span', { className: 'fs-run-node-bar-fill', style: { width: entry.progress + '%' } })),
  entry.members.length === 0
    ? null
    : h('div', { className: 'fs-run-node-members' },
      entry.members.map((member, index) => h('div', {
        key: member.name + ':' + index,
        className: 'fs-run-node-member',
        title: member.note === ''
          ? member.name + ' · ' + member.label
          : member.name + ' · ' + member.label + ' · ' + member.note,
      },
      h('span', { className: 'fs-run-node-member-name' }, member.name),
      ' · ',
      h('span', { className: 'fs-run-node-member-state ' + member.state }, member.label),
      member.note === '' ? null : ' · ' + member.note))),
  blockersText(entry.blockers) === ''
    ? null
    : h('div', {
      className: 'fs-run-node-blockers',
      title: '阻塞：' + entry.blockers.join('；'),
    }, blockersText(entry.blockers)))
}

/**
 * 节点自审状态区块（v0.8 §11.4，只读）：每个上报过的节点一行。
 * `nodes` 是 `GET /runs/<id>` 的节点表（`{id,title}`），只用来把 nodeId 换成标题。
 */
function NodeStatusBlock({ run, nodes }) {
  const entries = nodeStatusEntries(run)
  if (entries.length === 0) {
    return h('div', { className: 'fs-run-nodes' },
      h('div', { className: 'fs-run-nodes-empty' }, NODE_STATUS_EMPTY_TEXT))
  }
  const titles = nodeTitleMap(nodes)
  return h('div', { className: 'fs-run-nodes' },
    h('div', { className: 'fs-run-nodes-head' },
      h('span', { className: 'fs-run-sup-label' }, '节点状态'),
      h('span', { className: 'fs-run-nodes-count' }, entries.length + ' 个节点')),
    h('div', {
      className: 'fs-run-nodes-body' + (entries.length > NODE_STATUS_SCROLL_AT ? ' scroll' : ''),
    },
    entries.map(entry => h(NodeStatusRow, {
      key: entry.nodeId,
      entry,
      title: titles.get(entry.nodeId) || entry.nodeId,
    }))))
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

/** 运行详情头部：工作区 / worktree / supervision / 节点状态都只读。 */
function RunDetail({ run, active, nodes }) {
  const path = workspacePathOf(run)
  const worktree = worktreeOf(run)
  const name = text(run.name) || text(run.id) || '未命名运行'
  return h('div', { className: 'fs-run-detail' + (active ? ' on' : ''), 'aria-label': '运行详情头部' },
    h('div', { className: 'fs-run-detail-name', title: text(run.id) || name }, name),
    h('div', { className: 'fs-run-detail-line', title: path === '' ? UNKNOWN_WORKSPACE : path },
      '工作区 · ' + (path === '' ? UNKNOWN_WORKSPACE : workspaceTail(path))),
    h('div', { className: 'fs-run-detail-line' },
      'worktree · ' + (worktree.enabled ? (worktree.branch === '' ? '已启用' : '⎇ ' + worktree.branch) : '未启用')),
    h(SupervisionLine, { run }),
    h(NodeStatusBlock, { run, nodes }))
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
  // v0.8 §11.4：`GET /runs/<id>` 的节点表（`{id,title}`），只用于把 nodeId 显示成标题。
  nodes = null,
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
              selected ? h(RunDetail, {
                run: selected,
                active: text(selected.id) === activeRunId,
                nodes,
              }) : null,
              groups.map((group, index) => h(RunGroup, {
                key: group.key === '' ? 'unknown-workspace' : group.key,
                group,
                open: isGroupOpen(groupToggles, group.key, index),
                onToggle: toggleGroup,
                selectedRunId,
                onFocusRun,
              }))))))
}
