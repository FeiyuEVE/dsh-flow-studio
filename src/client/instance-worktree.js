/**
 * 实例工作区（worktree）面板（0.13.8）。
 *
 * 两个入口：
 *   1. 选中实例后的「工作区」区：模式 / 路径 / 分支 / HEAD / dirty / 可清理性，
 *      以及「刷新检查 / 删除工作树 / 只删分支」。删除是危险操作，页面内二次确认
 *      （不用 window.confirm，SSR 与测试都能渲染）；请求带 `expectedHead` 防误删。
 *   2. 全局「工作树清理」：先列清单，再 `dryRun` 预览；用户确认后才带 `planHash`
 *      执行。预演之后状态变化会让旧 `planHash` 失效（409 PLAN_STALE），此时只提示
 *      「重新预览」，不自动重试——删除动作不能靠自动重试吞掉冲突。
 *
 * 所有结果走页面现有的 notice 机制，保留服务端 `error` 原文；ACTIVE / SUSPENDED
 * 实例的清理按钮在客户端就禁用，服务端 409 仍按警告展示（可能是页面状态过期）。
 *
 * @module @feiyueve/dsh-flow-studio/client/instance-worktree
 */

import { api } from './api.js'
import { h, rt } from './runtime.js'

/** inspect 的确定性 state → 可读文案（未知 state 原样展示，不猜）。 */
export const WORKTREE_STATE_TEXT = Object.freeze({
  ok: '正常',
  missing: '目录已不存在',
  dirty: '有未提交改动',
  unregistered: '未被主仓库登记',
  'branch-mismatch': '分支与记录不一致',
  'head-mismatch': 'HEAD 与期望不一致',
  'path-unsafe': '路径不安全',
  'repository-missing': '主仓库目录不存在',
  'git-unavailable': 'Git 不可用',
  'invalid-record': '所有权记录损坏',
  error: '检查失败',
})

/** prune 条目的动作 → 可读文案。 */
export const PRUNE_ACTION_TEXT = Object.freeze({
  remove: '将删除',
  retain: '保留',
  report: '仅报告',
})

/** inspect 的 state → 语义色档（复用现有 fs-status-chip 的 tone）。 */
const STATE_TONE = Object.freeze({
  ok: 'success',
  dirty: 'warn',
  'branch-mismatch': 'warn',
  'head-mismatch': 'warn',
  unregistered: 'warn',
  'repository-missing': 'error',
  'git-unavailable': 'error',
  'invalid-record': 'error',
  'path-unsafe': 'error',
  error: 'error',
})

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 去掉句末标点，避免拼接时出现「。。」。 */
function sentence(text) {
  return String(text || '').replace(/[。；;.\s]+$/u, '')
}

/** inspect state → 中文；未知值原样展示。 */
export function worktreeStateText(state) {
  const key = textOf(state)
  if (key === '') return '未知'
  return WORKTREE_STATE_TEXT[key] || key
}

/** inspect state → 色档（未知按 warn）。 */
export function worktreeStateTone(state) {
  const key = textOf(state)
  return STATE_TONE[key] || 'warn'
}

/** 工作区模式：未配置 / 原目录 / worktree 隔离。 */
export function worktreeModeText(payload) {
  if (!isObject(payload) || payload.configured !== true) return '未配置'
  if (payload.mode === 'worktree' || isObject(payload.worktree)) return 'worktree 隔离'
  return '原目录'
}

/**
 * 清理按钮的禁用原因；空串 = 可以清理。
 *
 * 只按实例状态与「有没有登记 worktree」判：脏树 / 未登记等属于服务端二次校验的
 * 风险，页面用 dirty 标记与 force 选项呈现，不能因为 `cleanable:false` 就假装按钮
 * 一定可用或一定不可用（终态脏树仍可 force 清理）。
 */
export function cleanupDisabledReason(payload) {
  if (!isObject(payload) || payload.configured !== true || !isObject(payload.worktree)) {
    return '这个实例没有登记 worktree。'
  }
  const status = textOf(payload.instanceStatus).toUpperCase()
  if (status === 'ACTIVE') return '实例活跃（ACTIVE）：禁止清理工作树，先停止实例。'
  if (status === 'SUSPENDED') return '实例已挂起（SUSPENDED）：禁止清理工作树。'
  return ''
}

/** `error.data.error` 优先，保留服务端原因；没有就给通用文案。 */
export function worktreeErrorText(error) {
  if (!isObject(error) && typeof error !== 'object') return '未知错误'
  const data = isObject(error) && isObject(error.data) ? error.data : null
  const server = data && typeof data.error === 'string' ? data.error.trim() : ''
  if (server !== '') return server
  const message = error && typeof error.message === 'string' ? error.message.trim() : ''
  return message || '未知错误'
}

/**
 * 操作失败 → `{kind, stale, text}`。
 *
 * - 409 PLAN_STALE（prune 预览过期）：warning + `stale:true`，调用方清掉旧预览；
 * - 其它 409（实例 ACTIVE / 分支不属于本实例）：warning，保留服务端原因；
 * - 404：warning，提示刷新；
 * - 网络错误：error。
 */
export function worktreeFailurePlan(action, error) {
  const status = isObject(error) && Number.isInteger(error.status) ? error.status : 0
  const code = isObject(error) && typeof error.code === 'string' ? error.code : ''
  const server = worktreeErrorText(error)
  const prefix = action === 'remove'
    ? '删除工作树失败：'
    : action === 'branch'
      ? '删除分支失败：'
      : action === 'prune'
        ? '清理工作树失败：'
        : '读取工作区失败：'
  const stale = code === 'INSTANCE_WORKTREE_PLAN_STALE' || /PLAN_STALE/.test(code)
  const base = prefix + sentence(server)
  if (stale) {
    return { kind: 'warn', stale: true, text: `${base}。状态已变化，请重新预览后再执行。` }
  }
  if (status === 409) return { kind: 'warn', stale: false, text: `${base}。刷新后再决定。` }
  if (status === 404) return { kind: 'warn', stale: false, text: `${base}。刷新列表后再试。` }
  if (status === 0) return { kind: 'error', stale: false, text: `${base}（连不上 Host）。` }
  return { kind: 'error', stale: false, text: `${base}。` }
}

/** 预览 plan 的三类计数。 */
export function prunePlanSummary(plan) {
  const entries = isObject(plan) && Array.isArray(plan.entries) ? plan.entries : []
  const summary = { remove: 0, retain: 0, report: 0, total: entries.length }
  for (const entry of entries) {
    const action = entry && typeof entry.action === 'string' ? entry.action : 'report'
    if (action === 'remove') summary.remove += 1
    else if (action === 'retain') summary.retain += 1
    else summary.report += 1
  }
  return summary
}

/** 列表 / 预览里的条目：实例状态缺失时显示短横线，不猜 ACTIVE。 */
function factText(value) {
  const text = textOf(value)
  return text === '' ? '—' : text
}

function shortHead(head) {
  const text = textOf(head)
  return text === '' ? '—' : text.slice(0, 12)
}

function branchRemovalText(result) {
  if (!isObject(result)) return { kind: 'warn', text: '分支删除没有返回结果。' }
  const branch = factText(result.branch)
  if (result.removed === true) return { kind: 'success', text: `已删除实例分支 ${branch}。` }
  const reason = factText(result.reason)
  const warning = textOf(result.warning)
  return {
    kind: 'warn',
    text: `分支未删除（${reason}）${warning === '' ? '' : '：' + warning}`,
  }
}

/**
 * 实例工作区面板。请求与刷新由组件自己发起；页面只负责 notice 与列表刷新。
 *
 * @param {{
 *   client?: object,            // 客户端 API（默认全局 api；测试可注入桩）
 *   instanceId?: string,
 *   instanceStatus?: string,
 *   notice?: (kind: 'success'|'warn'|'error', text: string) => void,
 *   onChanged?: () => void,     // 清理后让页面刷新实例列表 / 详情
 * }} props
 */
export function InstanceWorktreePanel(props = {}) {
  // hooks 从宿主注入的 React 取：SSR / 测试探针共用同一份（与 page.js 同口径）。
  const React = rt.React
  const { useEffect, useState } = React
  const client = props.client && typeof props.client.readInstanceWorktree === 'function' ? props.client : api
  const instanceId = textOf(props.instanceId)
  const notice = typeof props.notice === 'function' ? props.notice : () => {}
  const onChanged = typeof props.onChanged === 'function' ? props.onChanged : () => {}

  const [payload, setPayload] = useState(null)
  const [loading, setLoading] = useState(instanceId !== '')
  const [errorText, setErrorText] = useState('')
  const [reloadTick, setReloadTick] = useState(0)
  const [confirmKind, setConfirmKind] = useState('')
  const [removeBranch, setRemoveBranch] = useState(true)
  const [force, setForce] = useState(false)
  const [busy, setBusy] = useState(false)

  const [pruneOpen, setPruneOpen] = useState(false)
  const [pruneLoading, setPruneLoading] = useState(false)
  const [pruneList, setPruneList] = useState(null)
  const [prunePreview, setPrunePreview] = useState(null)
  const [pruneError, setPruneError] = useState('')
  const [pruneExecuting, setPruneExecuting] = useState(false)
  const [pruneTick, setPruneTick] = useState(0)

  // 选中实例变化 / 手动刷新：只读检查，不触发 runner。
  useEffect(() => {
    if (instanceId === '') {
      setPayload(null)
      setLoading(false)
      setErrorText('')
      setConfirmKind('')
      return undefined
    }
    let cancelled = false
    setLoading(true)
    setErrorText('')
    setPayload(null)
    setConfirmKind('')
    client.readInstanceWorktree(instanceId).then(data => {
      if (cancelled) return
      setPayload(isObject(data) ? data : null)
      setLoading(false)
    }, error => {
      if (cancelled) return
      setLoading(false)
      const plan = worktreeFailurePlan('inspect', error)
      setErrorText(plan.text)
      notice(plan.kind, plan.text)
    })
    return () => { cancelled = true }
  }, [client, instanceId, reloadTick])

  // 全局清理：打开 / 重新预览时同时取清单与 dryRun 预览。两个请求互不掩盖：
  // 清单成功而预览失败时仍然展示列表，只是不能执行。
  useEffect(() => {
    if (!pruneOpen) return undefined
    let cancelled = false
    setPruneLoading(true)
    setPruneError('')
    setPrunePreview(null)
    Promise.allSettled([
      client.listInstanceWorktrees(),
      client.pruneInstanceWorktrees({ dryRun: true }),
    ]).then(([listed, preview]) => {
      if (cancelled) return
      setPruneLoading(false)
      if (listed.status === 'fulfilled') setPruneList(isObject(listed.value) ? listed.value : null)
      if (preview.status === 'fulfilled') setPrunePreview(isObject(preview.value) ? preview.value : null)
      const failed = [listed, preview].find(item => item.status === 'rejected')
      if (failed) {
        const plan = worktreeFailurePlan('prune', failed.reason)
        setPruneError(plan.text)
        notice(plan.kind, plan.text)
      }
    })
    return () => { cancelled = true }
  }, [client, pruneOpen, pruneTick])

  const needsInstance = instanceId !== ''
  const blockedReason = cleanupDisabledReason(payload)
  const worktree = isObject(payload) && isObject(payload.worktree) ? payload.worktree : null
  const status = textOf(payload && payload.instanceStatus)
  const planSummary = prunePreview === null ? null : prunePlanSummary(prunePreview.plan || prunePreview)

  function refreshAll() {
    setReloadTick(tick => tick + 1)
    if (pruneOpen) setPruneTick(tick => tick + 1)
    onChanged()
  }

  async function removeWorktree() {
    if (busy || instanceId === '' || blockedReason !== '' || worktree === null) return
    setBusy(true)
    try {
      const head = textOf(worktree.head)
      const body = { removeBranch: removeBranch === true }
      if (force === true) body.force = true
      // 刷新检查拿到的 HEAD 就是期望值：期间 tree 被别处改动时服务端会 409。
      if (/^[0-9a-f]{40,64}$/i.test(head)) body.expectedHead = head
      const data = await client.removeInstanceWorktree(instanceId, body)
      setConfirmKind('')
      if (removeBranch === true) {
        const branch = branchRemovalText(isObject(data) ? data.branchRemoval : null)
        notice(branch.kind, `${isObject(data) && data.removed === true ? '工作树已删除。' : '工作树未删除。'}${branch.text}`)
      } else if (isObject(data) && data.removed === true) {
        notice('success', '工作树已删除（分支保留）。')
      } else {
        notice('warn', `工作树未删除（${factText(isObject(data) ? data.reason : '')}）。`)
      }
      refreshAll()
    } catch (error) {
      const plan = worktreeFailurePlan('remove', error)
      notice(plan.kind, plan.text)
    } finally {
      setBusy(false)
    }
  }

  async function removeBranchOnly() {
    if (busy || instanceId === '' || blockedReason !== '' || worktree === null) return
    setBusy(true)
    try {
      const data = await client.removeInstanceWorktreeBranch(instanceId)
      setConfirmKind('')
      const branch = branchRemovalText(isObject(data) ? data.branchRemoval : null)
      notice(branch.kind, branch.text)
      refreshAll()
    } catch (error) {
      const plan = worktreeFailurePlan('branch', error)
      notice(plan.kind, plan.text)
    } finally {
      setBusy(false)
    }
  }

  async function executePrune() {
    if (pruneExecuting || planSummary === null || planSummary.remove < 1) return
    const planHash = textOf(prunePreview && prunePreview.planHash)
    if (planHash === '') {
      setPrunePreview(null)
      notice('warn', '预览没有返回 planHash，不能执行；请重新预览。')
      return
    }
    setPruneExecuting(true)
    try {
      const data = await client.pruneInstanceWorktrees({ dryRun: false, planHash })
      const removed = isObject(data) && Array.isArray(data.removed) ? data.removed.length : 0
      const skipped = isObject(data) && Array.isArray(data.skipped) ? data.skipped.length : 0
      notice(skipped > 0 ? 'warn' : 'success',
        `工作树清理完成：删除 ${removed} 个、跳过 ${skipped} 个${skipped > 0 ? '（原因见预览清单）' : ''}。`)
      // 执行后旧 plan 已消费：refreshAll 会重新预览一次，让页面显示最新状态。
      refreshAll()
    } catch (error) {
      const plan = worktreeFailurePlan('prune', error)
      notice(plan.kind, plan.text)
      if (plan.stale) {
        // 不自动重试：清掉旧预览，用户必须点「重新预览」。
        setPrunePreview(null)
      }
    } finally {
      setPruneExecuting(false)
    }
  }

  return h('section', {
    className: 'fs-wt',
    'aria-label': '实例工作区',
    'data-wt-instance': instanceId,
  },
  h('div', { className: 'fs-wt-head' },
    h('strong', null, '工作区'),
    h('button', {
      type: 'button',
      className: 'fs-btn sm ghost',
      disabled: !needsInstance || loading || busy,
      title: '重新读取实例工作区的路径 / Git 登记 / dirty / HEAD',
      'data-action': 'worktree-refresh',
      onClick: () => setReloadTick(tick => tick + 1),
    }, loading ? '检查中…' : '刷新检查')),

  needsInstance
    ? renderInstanceWorktree({
      payload,
      loading,
      errorText,
      blockedReason,
      busy,
      confirmKind,
      removeBranch,
      force,
      onConfirmKind: setConfirmKind,
      onRemoveBranch: setRemoveBranch,
      onForce: setForce,
      onRemove: removeWorktree,
      onRemoveBranchOnly: removeBranchOnly,
    })
    : h('p', { className: 'fs-wt-empty' }, '选中实例后显示它的工作区；也可以在下方清理全局工作树。'),

  h('div', { className: 'fs-wt-prune-head' },
    h('button', {
      type: 'button',
      className: 'fs-btn sm ghost',
      'data-action': 'worktree-prune-open',
      'aria-expanded': pruneOpen ? 'true' : 'false',
      title: '列出所有实例工作树，先预览再清理',
      onClick: () => setPruneOpen(open => !open),
    }, pruneOpen ? '收起清理' : '工作树清理'),
    pruneOpen
      ? h('button', {
        type: 'button',
        className: 'fs-btn sm ghost',
        disabled: pruneLoading || pruneExecuting,
        'data-action': 'worktree-prune-preview',
        title: '重新列出清单并做一次 dryRun 预览',
        onClick: () => setPruneTick(tick => tick + 1),
      }, '重新预览')
      : null),

  pruneOpen
    ? renderPrune({
      loading: pruneLoading,
      error: pruneError,
      list: pruneList,
      preview: prunePreview,
      summary: planSummary,
      executing: pruneExecuting,
      onExecute: executePrune,
    })
    : null)
}

/** 单个实例的工作区详情 + 清理按钮（含二次确认）。 */
function renderInstanceWorktree(context) {
  const {
    payload, loading, errorText, blockedReason, busy, confirmKind, removeBranch, force,
    onConfirmKind, onRemoveBranch, onForce, onRemove, onRemoveBranchOnly,
  } = context
  if (loading) return h('p', { className: 'fs-wt-empty' }, '正在读取工作区…')
  if (errorText !== '') {
    return h('div', { className: 'fs-wt-error', role: 'alert', 'data-wt-error': 'true' }, errorText)
  }
  if (!isObject(payload) || payload.configured !== true) {
    return h('div', { className: 'fs-wt-body', 'data-wt-mode': 'none' },
      h('p', { className: 'fs-wt-empty' }, '未配置工作区：这个实例没有登记工作区快照（旧实例或创建时未传 workspace）。'),
      h('p', { className: 'fs-wt-note' }, '没有工作区就没有可清理的 worktree。'))
  }
  const worktree = isObject(payload.worktree) ? payload.worktree : null
  const mode = worktreeModeText(payload)
  if (worktree === null) {
    return h('div', { className: 'fs-wt-body', 'data-wt-mode': 'directory' },
      h('dl', { className: 'fs-wt-facts' },
        h('div', null, h('dt', null, '模式'), h('dd', { 'data-wt-field': 'mode' }, mode)),
        h('div', null, h('dt', null, '路径'), h('dd', { 'data-wt-field': 'path' }, factText(payload.effectiveRoot))),
        h('div', null, h('dt', null, '清理策略'), h('dd', null, factText(payload.cleanupPolicy)))),
      h('p', { className: 'fs-wt-note' }, '该实例直接使用原目录，没有独立工作树；没有可清理的 worktree。'))
  }
  const state = textOf(worktree.state)
  const reasons = Array.isArray(worktree.reasons) ? worktree.reasons.filter(item => typeof item === 'string' && item !== '') : []
  const cleanable = payload.cleanable === true
  const dirty = worktree.dirty === true
  const status = textOf(payload.instanceStatus)
  return h('div', { className: 'fs-wt-body', 'data-wt-mode': 'worktree' },
    h('dl', { className: 'fs-wt-facts' },
      h('div', null, h('dt', null, '模式'), h('dd', { 'data-wt-field': 'mode' }, mode)),
      h('div', null, h('dt', null, '路径'), h('dd', { 'data-wt-field': 'path', title: factText(worktree.path) },
        factText(worktree.path))),
      h('div', null, h('dt', null, '分支'), h('dd', { 'data-wt-field': 'branch' }, factText(worktree.branch))),
      h('div', null, h('dt', null, 'HEAD'), h('dd', { 'data-wt-field': 'head' }, shortHead(worktree.head))),
      h('div', null, h('dt', null, '检查'), h('dd', { 'data-wt-field': 'state' },
        h('span', { className: 'fs-status-chip ' + worktreeStateTone(state) }, worktreeStateText(state))))),
    h('div', { className: 'fs-wt-badges' },
      h('span', { className: 'fs-view-badge' + (dirty ? ' warn' : ''), 'data-wt-field': 'dirty' },
        worktree.dirty === true ? '有未提交改动' : (worktree.dirty === false ? '工作树干净' : 'dirty 未知')),
      h('span', { className: 'fs-view-badge', 'data-wt-field': 'cleanable' },
        cleanable ? '可清理' : '不可清理'),
      status !== '' ? h('span', { className: 'fs-view-badge' }, `实例 ${status}`) : null),
    reasons.length === 0
      ? null
      : h('ul', { className: 'fs-wt-reasons' }, reasons.map(reason => h('li', { key: reason }, reason))),
    blockedReason !== ''
      ? h('p', { className: 'fs-wt-blocked', 'data-wt-blocked': 'true' }, blockedReason)
      : null,
    h('div', { className: 'fs-wt-actions' },
      h('button', {
        type: 'button',
        className: 'fs-btn sm danger',
        disabled: busy || blockedReason !== '',
        title: blockedReason !== '' ? blockedReason : '删除这个实例的工作树（危险操作，需二次确认）',
        'data-action': 'worktree-remove',
        onClick: () => onConfirmKind('remove'),
      }, '删除工作树'),
      h('button', {
        type: 'button',
        className: 'fs-btn sm ghost',
        disabled: busy || blockedReason !== '',
        title: blockedReason !== '' ? blockedReason : '只删除记录确属本实例的分支，不动目录',
        'data-action': 'worktree-branch',
        onClick: () => onConfirmKind('branch'),
      }, '只删分支')),

    confirmKind === 'remove'
      ? h('div', { className: 'fs-wt-confirm', role: 'group', 'aria-label': '确认删除工作树', 'data-wt-confirm': 'remove' },
        h('p', { className: 'fs-wt-danger' },
          `将删除 ${factText(worktree.path)}。目录删除与分支删除分别返回结果，此操作不可撤销。`),
        h('label', { className: 'fs-wt-check' },
          h('input', {
            type: 'checkbox',
            checked: removeBranch,
            'data-action': 'worktree-remove-branch-option',
            onChange: event => onRemoveBranch(event && event.target ? event.target.checked : false),
          }),
          '同时删除实例分支'),
        h('label', { className: 'fs-wt-check' },
          h('input', {
            type: 'checkbox',
            checked: force,
            'data-action': 'worktree-force-option',
            onChange: event => onForce(event && event.target ? event.target.checked : false),
          }),
          '强制删除（脏树 / 未提交改动 / 未合并提交）'),
        h('div', { className: 'fs-wt-actions' },
          h('button', {
            type: 'button', className: 'fs-btn sm danger', disabled: busy,
            'data-action': 'worktree-remove-confirm', onClick: onRemove,
          }, busy ? '删除中…' : '确认删除'),
          h('button', {
            type: 'button', className: 'fs-btn sm ghost', disabled: busy,
            'data-action': 'worktree-remove-cancel', onClick: () => onConfirmKind(''),
          }, '取消')))
      : null,

    confirmKind === 'branch'
      ? h('div', { className: 'fs-wt-confirm', role: 'group', 'aria-label': '确认删除分支', 'data-wt-confirm': 'branch' },
        h('p', { className: 'fs-wt-danger' },
          `将删除实例分支 ${factText(worktree.branch)}（不动目录）。只删记录确属本实例的分支。`),
        h('div', { className: 'fs-wt-actions' },
          h('button', {
            type: 'button', className: 'fs-btn sm danger', disabled: busy,
            'data-action': 'worktree-branch-confirm', onClick: onRemoveBranchOnly,
          }, busy ? '删除中…' : '确认删除分支'),
          h('button', {
            type: 'button', className: 'fs-btn sm ghost', disabled: busy,
            'data-action': 'worktree-branch-cancel', onClick: () => onConfirmKind(''),
          }, '取消')))
      : null)
}

/** 全局工作树清理：清单 + dryRun 预览 + 带 planHash 执行。 */
function renderPrune({ loading, error, list, preview, summary, executing, onExecute }) {
  const entries = isObject(list) && Array.isArray(list.worktrees) ? list.worktrees : []
  const orphans = isObject(list) && Array.isArray(list.orphans) ? list.orphans.length : 0
  const planEntries = isObject(preview) && isObject(preview.plan) && Array.isArray(preview.plan.entries)
    ? preview.plan.entries
    : []
  return h('div', { className: 'fs-wt-prune', 'data-prune-open': 'true' },
    loading
      ? h('p', { className: 'fs-wt-empty' }, '正在列出工作树并生成预览…')
      : null,
    error !== '' ? h('div', { className: 'fs-wt-error', role: 'alert', 'data-prune-error': 'true' }, error) : null,
    loading || isObject(list) === false
      ? null
      : [
        h('p', { key: 'summary', className: 'fs-wt-note' },
          `共 ${entries.length} 个实例工作树，其中孤儿 ${orphans} 个。`),
        entries.length === 0
          ? h('p', { key: 'empty', className: 'fs-wt-empty' }, '没有登记的工作树。')
          : h('ul', { key: 'rows', className: 'fs-wt-rows' }, entries.map(entry => h('li', {
            key: `${entry.workspaceId || '?'}/${entry.instanceId || '?'}`,
            className: 'fs-wt-row',
            'data-wt-row': `${entry.workspaceId || ''}/${entry.instanceId || ''}`,
          },
          h('span', { className: 'fs-wt-row-id' }, factText(entry.instanceId)),
          h('span', { className: 'fs-wt-row-meta' },
            `${factText(entry.instanceStatus)} · ${entry.orphan === true ? '孤儿' : '正常'} · ${shortHead(entry.workspaceId)}`),
          h('span', { className: 'fs-wt-row-path', title: factText(entry.path) }, factText(entry.path))))),
      ],
    !isObject(preview)
      ? (loading ? null : h('p', { className: 'fs-wt-empty', 'data-prune-stale': 'true' },
        '还没有可用预览：点「重新预览」生成 planHash 后再执行。'))
      : h('div', { className: 'fs-wt-plan', 'data-prune-hash': textOf(preview.planHash) },
        h('p', { className: 'fs-wt-note' },
          `预览：将删除 ${summary.remove} 个 / 保留 ${summary.retain} 个 / 仅报告 ${summary.report} 个。`),
        planEntries.length === 0
          ? h('p', { className: 'fs-wt-empty' }, '预览清单为空。')
          : h('ul', { className: 'fs-wt-rows' }, planEntries.map((entry, index) => h('li', {
            key: `${entry.workspaceId || '?'}/${entry.instanceId || '?'}/${index}`,
            className: 'fs-wt-row',
          },
          h('span', { className: 'fs-wt-row-id' }, `${PRUNE_ACTION_TEXT[entry.action] || factText(entry.action)} ${factText(entry.instanceId)}`),
          h('span', { className: 'fs-wt-row-meta' }, `${factText(entry.reason)}${entry.dirty === true ? ' · 脏树' : ''}${entry.instanceStatus ? ' · ' + entry.instanceStatus : ''}`),
          h('span', { className: 'fs-wt-row-path', title: factText(entry.path) }, factText(entry.path))))),
        h('p', { className: 'fs-wt-hash' }, 'planHash：', h('code', null, textOf(preview.planHash))),
        h('div', { className: 'fs-wt-actions' },
          h('button', {
            type: 'button',
            className: 'fs-btn sm danger',
            disabled: executing || summary.remove < 1,
            title: summary.remove < 1 ? '预览里没有可删除的条目' : '按这份 planHash 执行删除（状态变化会返回 409）',
            'data-action': 'worktree-prune-exec',
            onClick: onExecute,
          }, executing ? '执行中…' : `执行清理（${summary.remove}）`))),
  )
}
