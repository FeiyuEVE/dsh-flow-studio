/**
 * 实例运行指标面板（0.13.10 E1）。
 *
 * 两个入口：
 *   1. 实例详情里的「运行指标」区（`GET /instances/<id>/metrics`）：
 *      墙钟 / 挂起 / 人工等待、agent 调用与 token、finish_reminder、connector、
 *      节点执行数、当前活动与等待任务、数据完整性原因。
 *   2. 实例列表上方的「汇总」区（`GET /metrics?groupBy=day`）：
 *      按实例 `createdAt` 选 cohort 的跨实例汇总 + 每日分组。
 *
 * 展示硬口径：
 *   - **未知不是零**：`null` 一律显示「未知 / 无样本」，绝不渲染成 0；
 *   - 没有「流程完成百分比」；只显示已执行节点数、当前活动、等待任务；
 *   - 业务变量只读显式标量，并明确标成「业务指标」。
 *
 * @module @feiyueve/dsh-flow-studio/client/instance-metrics
 */

import { h, rt } from './runtime.js'

/** `dataQuality.reasons` → 中文（未知原因原样展示，不吞掉）。 */
export const METRICS_REASON_TEXT = Object.freeze({
  'usage-unavailable': '没有可观测的 usage（token 未知，不是 0）',
  'usage-malformed': 'usage 字段形状不可识别',
  'usage-missing-buckets': '四桶里有些桶从未上报',
  'usage-partial': '部分调用只观测到部分桶（完整 total 未知，展示的是已观测小计）',
  'usage-scope-unknown': '结算快照的作用域不可证明（resume / 缺范围 id），未按数值猜总量',
  'usage-output-provisional': 'assistant 的 output 可能只是占位值，且没有 result 结算',
  'usage-history-mask-missing': '旧事件没有观测掩码，无法区分真实 0 与补零（完整性未知）',
  'legacy-usage-fallback': 'token 来自旧 activity/end.usage 兜底',
  'agent-invocation-unavailable': '旧事件流没有 agent 调用身份',
  'events-skipped': '事件流有坏行被跳过',
  'resources-skipped': '资源事件有坏行被跳过',
  'event-log-gap': '事件序号有缺口（可能正在写入）',
  'invalid-timestamps': '存在无法解析的时间戳',
  'suspend-timeline-unavailable': '实例处于挂起但没有 suspend/resume 区间',
  'connector-records-missing': 'connector 只有尝试事件、没有调用记录',
  'connector-record-invalid': 'connector 调用记录形状非法',
})

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 原因 → 中文；未知原因原样展示。 */
export function metricsReasonText(reason) {
  const key = textOf(reason)
  if (key === '') return '未知原因'
  return METRICS_REASON_TEXT[key] || key
}

/** 毫秒 → 稳定短格式；`null/undefined` = 未知（**不是 0ms**）。 */
export function formatDurationMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '未知'
  if (value < 1000) return `${Math.round(value)}ms`
  const seconds = value / 1000
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`
  const minutes = seconds / 60
  if (minutes < 60) {
    const whole = Math.floor(minutes)
    const rest = Math.round((minutes - whole) * 60)
    return `${whole}m${rest === 0 ? '' : `${rest}s`}`
  }
  const hours = Math.floor(minutes / 60)
  const rest = Math.round(minutes - hours * 60)
  return `${hours}h${rest === 0 ? '' : `${rest}m`}`
}

/** token 总量：`null` = 未知；`partial` = 只观测到一部分（**不是 0**）。 */
export function formatTokens(usage) {
  if (!isObject(usage)) return '未知'
  if (typeof usage.total === 'number' && Number.isFinite(usage.total)) return String(usage.total)
  if (usage.partial === true) return '部分'
  return '未知'
}

/** 一次 token 四桶明细：未观测的桶写「未知」，绝不渲染成 0。 */
export function tokenBreakdownText(usage) {
  if (!isObject(usage)) return ''
  const parts = []
  for (const [key, label] of [['input', '输入'], ['cacheRead', '缓存读'], ['cacheWrite', '缓存写'], ['output', '输出']]) {
    const value = usage[key]
    parts.push(`${label} ${typeof value === 'number' && Number.isFinite(value) ? value : '未知'}`)
  }
  return parts.join(' · ')
}

/** 覆盖率文案：known / partial / unknown 都显示，不让未知消失（partial=0 不显示）。 */
export function coverageText(coverage) {
  if (!isObject(coverage)) return '未知'
  const known = Number.isFinite(coverage.known) ? coverage.known : 0
  const partial = Number.isFinite(coverage.partial) ? coverage.partial : 0
  const unknown = Number.isFinite(coverage.unknown) ? coverage.unknown : 0
  return partial > 0
    ? `已观测 ${known} · 部分 ${partial} · 未知 ${unknown}`
    : `已观测 ${known} · 未知 ${unknown}`
}

/** 成功率文案：没有样本 → 「无样本」，绝不显示 0%。 */
export function successRateText(rate) {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return '无样本'
  return `${Math.round(rate * 1000) / 10}%`
}

/** connector 延迟摘要：单次请求 / 含退避总耗时分开。 */
export function latencyText(latency) {
  if (!isObject(latency)) return '无样本'
  const part = item => {
    if (!isObject(item) || !Number.isFinite(item.samples) || item.samples === 0) return '无样本'
    return `p50 ${formatDurationMs(item.p50Ms)} · p95 ${formatDurationMs(item.p95Ms)}（${item.samples} 次）`
  }
  return `请求 ${part(latency.request)}；总耗时 ${part(latency.total)}`
}

/** 实例是否终态（只影响轮询频率）。 */
export function metricsShouldPoll(status) {
  const text = textOf(status).toUpperCase()
  return text !== 'COMPLETED' && text !== 'CANCELED'
}

/** 请求失败 → `{kind, text}`，保留服务端原因。 */
export function metricsFailurePlan(action, error) {
  const status = isObject(error) && Number.isInteger(error.status) ? error.status : 0
  const data = isObject(error) && isObject(error.data) ? error.data : null
  const server = data && typeof data.error === 'string' ? data.error.trim() : ''
  const base = (action === 'summary' ? '读取汇总指标失败：' : '读取运行指标失败：')
    + (server || (error && typeof error.message === 'string' ? error.message : '未知错误'))
  if (status === 0) return { kind: 'error', text: `${base}（连不上 Host）。` }
  if (action === 'summary' && status === 400) return { kind: 'warn', text: `${base}。检查筛选参数后重试。` }
  return { kind: 'error', text: `${base}。` }
}

/** 从指标信封里取安全默认值（字段缺失不抛错）。 */
export function metricsSections(payload) {
  if (!isObject(payload)) return null
  return {
    duration: isObject(payload.duration) ? payload.duration : {},
    agent: isObject(payload.agent) ? payload.agent : {},
    human: isObject(payload.human) ? payload.human : {},
    finishReminder: isObject(payload.finishReminder) ? payload.finishReminder : {},
    connector: isObject(payload.connector) ? payload.connector : {},
    nodes: isObject(payload.nodes) ? payload.nodes : {},
    business: isObject(payload.business) ? payload.business : {},
    dataQuality: isObject(payload.dataQuality) ? payload.dataQuality : {},
  }
}

function fact(label, value, dataField) {
  return h('div', null,
    h('dt', null, label),
    h('dd', dataField ? { 'data-metrics-field': dataField } : null, value))
}

function renderReasons(reasons) {
  if (!Array.isArray(reasons) || reasons.length === 0) return null
  return h('ul', { className: 'fs-metrics-reasons', 'data-metrics-reasons': 'true' },
    reasons.map(reason => h('li', { key: reason }, metricsReasonText(reason))))
}

/** 单实例指标区（挂在实例详情里）。 */
export function InstanceMetricsPanel(props = {}) {
  const React = rt.React
  if (!React) throw new Error('InstanceMetricsPanel 需要先由宿主注入 React（bindReact）')
  const { useEffect, useState } = React
  const useCallback = typeof React.useCallback === 'function' ? React.useCallback : fn => fn
  const client = props.client && typeof props.client.readInstanceMetrics === 'function' ? props.client : null
  const instanceId = textOf(props.instanceId)
  const [payload, setPayload] = useState(null)
  const [loading, setLoading] = useState(false)
  const [errorText, setErrorText] = useState('')
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (client === null || instanceId === '') return undefined
    let cancelled = false
    setLoading(true)
    setErrorText('')
    Promise.resolve()
      .then(() => client.readInstanceMetrics(instanceId))
      .then(data => {
        if (cancelled) return
        setPayload(isObject(data) ? data : null)
      })
      .catch(error => {
        if (cancelled) return
        const plan = metricsFailurePlan('instance', error)
        setErrorText(plan.text)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [client, instanceId, tick])

  const refresh = useCallback(() => setTick(current => current + 1), [])
  const sections = metricsSections(payload)
  const status = textOf(props.instanceStatus).toUpperCase()
  const empty = instanceId === '' && sections === null
  const unsupported = client === null && instanceId !== ''

  return h('section', {
    className: 'fs-metrics',
    'aria-label': '实例运行指标',
    'data-metrics-instance': instanceId,
  },
  h('div', { className: 'fs-metrics-head' },
    h('strong', null, '运行指标'),
    h('button', {
      type: 'button',
      className: 'fs-btn sm ghost',
      disabled: loading || instanceId === '',
      title: '重新读取 GET /instances/<id>/metrics（纯读，不启动 runner）',
      'data-action': 'metrics-refresh',
      onClick: refresh,
    }, loading ? '读取中…' : '刷新指标')),

  empty
    ? h('p', { className: 'fs-metrics-empty' }, '选中实例后显示运行指标。')
    : null,
  unsupported
    ? h('p', { className: 'fs-metrics-empty', 'data-metrics-unsupported': 'true' }, '当前客户端没有指标接口（需要 Host 0.13.10+）。')
    : null,
  errorText !== ''
    ? h('div', { className: 'fs-metrics-error', role: 'alert', 'data-metrics-error': 'true' }, errorText)
    : null,
  loading && sections === null
    ? h('p', { className: 'fs-metrics-empty' }, '正在读取指标…')
    : null,

  sections !== null
    ? h('div', { className: 'fs-metrics-body', 'data-metrics-status': status },
      h('dl', { className: 'fs-metrics-facts' },
        fact('墙钟耗时', formatDurationMs(sections.duration.wallMs), 'wallMs'),
        fact('挂起耗时', formatDurationMs(sections.duration.suspendedMs), 'suspendedMs'),
        fact('完成人工等待', formatDurationMs(sections.human.completedWaitMs), 'completedWaitMs'),
        fact('当前人工等待', formatDurationMs(sections.human.currentWaitMs), 'currentWaitMs'),
        fact('执行 / 当前活动', `${sections.nodes.executed ?? 0} 个执行 · ${Array.isArray(sections.nodes.active) ? sections.nodes.active.length : 0} 个活动`,
          'nodes'),
        fact('等待任务', Array.isArray(sections.nodes.waitingTasks) && sections.nodes.waitingTasks.length > 0
          ? sections.nodes.waitingTasks.map(task => task.elementId || task.executionId || '?').join(' / ')
          : '无', 'waitingTasks')),
      h('div', { className: 'fs-metrics-badges' },
        h('span', { className: 'fs-view-badge', 'data-metrics-field': 'complete' },
          payload.complete === true ? '事件已追平' : '事件未追平'),
        h('span', { className: 'fs-view-badge', 'data-metrics-field': 'throughSeq' },
          `throughSeq ${Number.isFinite(payload.throughSeq) ? payload.throughSeq : '未知'}`)),
      h('dl', { className: 'fs-metrics-facts' },
        fact('agent 调用', sections.agent.invocations === null ? '未知' : String(sections.agent.invocations ?? 0), 'invocations'),
        fact('模型调用', sections.agent.modelCalls === null ? '未知' : String(sections.agent.modelCalls ?? 0), 'modelCalls'),
        fact('观测 token', formatTokens(sections.agent.observedTokens), 'observedTokens'),
        fact('usage 覆盖', coverageText(sections.agent.usageCoverage), 'usageCoverage'),
        fact('finish_reminder', `${sections.finishReminder.fires ?? 0} 次 · 未完结 ${sections.finishReminder.missingExecutions ?? 0}`,
          'finishReminder')),
      tokenBreakdownText(sections.agent.observedTokens) === ''
        ? null
        : h('p', { className: 'fs-metrics-note', 'data-metrics-field': 'tokenBuckets' },
          tokenBreakdownText(sections.agent.observedTokens)),
      h('dl', { className: 'fs-metrics-facts' },
        fact('connector 执行成功率', successRateText(sections.connector.successRate), 'connectorSuccessRate'),
        fact('connector attempt 成功率', successRateText(sections.connector.attempts?.successRate), 'attemptSuccessRate'),
        fact('connector 延迟', latencyText(sections.connector.latency), 'connectorLatency')),
      renderReasons(sections.dataQuality.reasons),
      Object.keys(sections.business.scalars || {}).length === 0
        ? null
        : h('div', { className: 'fs-metrics-business', 'data-metrics-business': 'true' },
          h('span', { className: 'fs-metrics-note' }, '业务指标（显式标量变量，不是流程完成百分比）：'),
          h('code', null, JSON.stringify(sections.business.scalars))))
    : null)
}

/** 跨实例汇总区（列表上方；`groupBy=day`）。 */
export function MetricsSummaryPanel(props = {}) {
  const React = rt.React
  if (!React) throw new Error('MetricsSummaryPanel 需要先由宿主注入 React（bindReact）')
  const { useEffect, useState } = React
  const useCallback = typeof React.useCallback === 'function' ? React.useCallback : fn => fn
  const client = props.client && typeof props.client.readMetrics === 'function' ? props.client : null
  const [payload, setPayload] = useState(null)
  const [loading, setLoading] = useState(false)
  const [errorText, setErrorText] = useState('')
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (client === null) return undefined
    let cancelled = false
    setLoading(true)
    setErrorText('')
    Promise.resolve()
      .then(() => client.readMetrics({ groupBy: 'day' }))
      .then(data => {
        if (cancelled) return
        setPayload(isObject(data) ? data : null)
      })
      .catch(error => {
        if (cancelled) return
        setErrorText(metricsFailurePlan('summary', error).text)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [client, tick])

  const refresh = useCallback(() => setTick(current => current + 1), [])
  const totals = isObject(payload?.totals) ? payload.totals : null
  const groups = Array.isArray(payload?.groups) ? payload.groups : []

  if (client === null) return null

  return h('section', { className: 'fs-metrics fs-metrics-summary', 'aria-label': '实例汇总指标', 'data-metrics-summary': 'true' },
    h('div', { className: 'fs-metrics-head' },
      h('strong', null, '指标汇总'),
      h('button', {
        type: 'button',
        className: 'fs-btn sm ghost',
        disabled: loading,
        title: '按实例 createdAt 选 cohort，分组读 GET /metrics?groupBy=day',
        'data-action': 'metrics-summary-refresh',
        onClick: refresh,
      }, loading ? '读取中…' : '刷新汇总')),
    errorText !== ''
      ? h('div', { className: 'fs-metrics-error', role: 'alert', 'data-metrics-error': 'true' }, errorText)
      : null,
    totals === null
      ? h('p', { className: 'fs-metrics-empty' }, '正在读取汇总…')
      : h('div', null,
        h('dl', { className: 'fs-metrics-facts' },
          fact('实例数', String(totals.instances ?? 0), 'instanceCount'),
          fact('状态', `活跃 ${totals.byStatus?.ACTIVE ?? 0} · 完成 ${totals.byStatus?.COMPLETED ?? 0} · 挂起 ${totals.byStatus?.SUSPENDED ?? 0} · 取消 ${totals.byStatus?.CANCELED ?? 0}`, 'byStatus'),
          fact('墙钟合计', formatDurationMs(totals.duration?.wallMs), 'totalWallMs'),
          fact('token 合计', formatTokens(totals.agent?.observedTokens), 'totalTokens'),
          fact('connector 成功率', successRateText(totals.connector?.successRate), 'totalSuccessRate'),
          fact('数据缺口', String(totals.dataQuality?.skippedInstances ?? 0), 'skippedInstances')),
        groups.length === 0
          ? null
          : h('ul', { className: 'fs-metrics-groups', 'data-metrics-groups': 'true' },
            groups.map(group => h('li', { key: group.key, 'data-metrics-day': group.key },
              h('span', { className: 'fs-metrics-day' }, group.key),
              h('span', { className: 'fs-metrics-groups-meta' },
                `${group.instances} 个实例 · 墙钟 ${formatDurationMs(group.duration?.wallMs)} · token ${formatTokens(group.agent?.observedTokens)} · connector ${successRateText(group.connector?.successRate)}`))))))
}
