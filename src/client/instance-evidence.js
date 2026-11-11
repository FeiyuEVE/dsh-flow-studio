/**
 * 实例详情「证据」面板（0.13.12 E2）。
 *
 * 只展示 `GET /instances/<id>/evidence` 返回的业务证据事实：
 *   - claims：报告自述的结论 + 引用核对情况（**不是**宿主裁决的结论）；
 *   - findings：status 原样展示；只有 `fixed` 且复验引用全部核对通过时，
 *     才显示 `verified` 徽标，且徽标语义只是「复验引用已核对」；
 *   - verifiedRefs / missing / conflicts / sourceExecutions / dataQuality。
 *
 * 硬口径：
 *   - 没有报告是「未知」，不渲染成「全部通过」；
 *   - 不产出「优 / 良 / 差」或统一 pass / warn / fail 总评级；
 *   - `dataQuality.stub` 必须一眼可辨；报告自称 `producer:"host"` 不会在这里变成宿主结论。
 *
 * @module @feiyueve/dsh-flow-studio/client/instance-evidence
 */

import { h, rt } from './runtime.js'

/** 后端 `EVIDENCE_REASON` → 中文；未知原因原样展示，不吞掉。 */
export const EVIDENCE_REASON_TEXT = Object.freeze({
  'no-evidence-report': '没有登记证据报告；质量结论未知',
  'report-unreadable': '证据报告读不到或不是合法 JSON',
  'report-schema-mismatch': '报告 schema / claims / findings 形状不合法',
  'report-invalid': '报告内容不合法',
  'report-empty': '报告没有任何 claims / findings',
  'report-stub': '报告自报为桩数据，不能当作真实质量通过',
  'producer-self-claim-ignored': '报告自称的 producer / authority / trust 已被忽略',
  'report-execution-mismatch': '报告自称的 executionId 与宿主登记不一致',
  'artifact-snapshot-missing': '引用没有 artifact 快照，已尝试回落到工作区',
  'workspace-fallback': '引用从工作区回落读取（快照缺失）',
  'workspace-unavailable': '工作区不可用，无法回落核对',
  'workspace-unreadable': '工作区文件读不到',
  'ref-path-invalid': '引用 path 不是安全的工作区相对路径',
  'ref-sha-invalid': '引用 sha256 不合法',
  'ref-hash-mismatch': '引用内容 hash 与声明的 sha256 不一致',
  'ref-missing': '引用对象缺失或形状非法',
  'fixed-without-verification-refs': 'finding 自称 fixed 但没有复验引用',
  'fixed-refs-unverified': 'finding 自称 fixed 但复验引用未全部命中归档快照 / 核对通过',
  'finding-self-verified-claim': 'finding 自称 verified，但没有宿主核对的复验引用',
  'claim-invalid': 'claim 形状非法',
  'finding-invalid': 'finding 形状非法',
  'claim-value-conflict': '同一 execution 内同 ID claim 的 value 冲突',
  'finding-status-conflict': '同一 execution 内同 ID finding 的 status 冲突',
  'cross-execution-claim-divergence': '不同 execution 对同一 claim 给出不同 value（来源都保留）',
  'cross-execution-finding-divergence': '不同 execution 对同一 finding 给出不同 status（来源都保留）',
  'duplicate-claim-id': '同一 execution 内 claim ID 重复',
  'duplicate-finding-id': '同一 execution 内 finding ID 重复',
  'claim-without-refs': 'claim 没有引用，只能算报告自述',
  'events-skipped': '事件流有坏行被跳过',
  'evidence-truncated': '证据数量超过展示上限，已截断',
})

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 原因 → 中文；未知原因原样展示。 */
export function evidenceReasonText(reason) {
  const key = textOf(reason)
  if (key === '') return '未知原因'
  return EVIDENCE_REASON_TEXT[key] || key
}

/** 证据整体状态 → 中文。不是总评级。 */
export function evidenceStatusText(status) {
  const key = textOf(status).toLowerCase()
  if (key === 'missing') return '未知：没有证据报告'
  if (key === 'invalid') return '未知：报告不可读'
  if (key === 'partial') return '部分：报告已读，存在缺失或冲突'
  if (key === 'present') return '已读：报告与引用核对结果如下'
  return '未知'
}

/** 失败文案：保留服务端原因。 */
export function evidenceFailurePlan(error) {
  const status = isObject(error) && Number.isInteger(error.status) ? error.status : 0
  const data = isObject(error) && isObject(error.data) ? error.data : null
  const server = data && typeof data.error === 'string' ? data.error.trim() : ''
  const base = '读取实例证据失败：'
    + (server || (error && typeof error.message === 'string' ? error.message : '未知错误'))
  if (status === 0) return { kind: 'error', text: `${base}（连不上 Host）。` }
  if (status === 404) return { kind: 'warn', text: `${base}。实例可能已被删除。` }
  if (status === 400) return { kind: 'warn', text: `${base}。检查查询参数后重试。` }
  return { kind: 'error', text: `${base}。` }
}

/** 从证据信封里取安全默认值（字段缺失不抛错）。 */
export function evidenceSections(payload) {
  if (!isObject(payload)) return null
  return {
    claims: Array.isArray(payload.claims) ? payload.claims : [],
    findings: Array.isArray(payload.findings) ? payload.findings : [],
    verifiedRefs: Array.isArray(payload.verifiedRefs) ? payload.verifiedRefs : [],
    missing: Array.isArray(payload.missing) ? payload.missing : [],
    conflicts: Array.isArray(payload.conflicts) ? payload.conflicts : [],
    sourceExecutions: Array.isArray(payload.sourceExecutions) ? payload.sourceExecutions : [],
    dataQuality: isObject(payload.dataQuality) ? payload.dataQuality : {},
  }
}

/** finding 展示徽标：只有 verified=true 才允许显示 verified。 */
export function findingBadge(finding) {
  if (!isObject(finding)) return { tone: 'neutral', text: '未知' }
  if (finding.verified === true) return { tone: 'verified', text: 'verified（复验引用已核对）' }
  const status = textOf(finding.status) || 'unknown'
  if (status.toLowerCase() === 'fixed') return { tone: 'neutral', text: 'fixed（未复验，不显示 verified）' }
  if (status.toLowerCase() === 'verified') return { tone: 'neutral', text: 'claimed-verified（报告自述，不是核对结果）' }
  return { tone: 'neutral', text: status }
}

/** claim 的值：只作为报告自述展示。 */
export function claimValueText(value) {
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function fact(label, value, dataField) {
  return h('div', null,
    h('dt', null, label),
    h('dd', dataField ? { 'data-evidence-field': dataField } : null, value))
}

function renderReasonList(reasons) {
  if (!Array.isArray(reasons) || reasons.length === 0) return null
  return h('ul', { className: 'fs-evidence-reasons', 'data-evidence-reasons': 'true' },
    reasons.map(reason => h('li', { key: reason }, evidenceReasonText(reason))))
}

function renderRefs(refs) {
  if (!Array.isArray(refs) || refs.length === 0) return null
  return h('ul', { className: 'fs-evidence-refs' },
    refs.map((ref, index) => h('li', {
      key: `${ref?.path ?? ''}\0${ref?.sha256 ?? ''}\0${index}`,
      'data-evidence-ref': ref?.verified === true ? 'verified' : 'unverified',
    },
    h('code', null, textOf(ref?.path) || '?'),
    ` · ${ref?.verified === true ? '引用已核对' : '引用未核对'}`
      + (textOf(ref?.resolvedFrom) === '' ? '' : ` · ${ref.resolvedFrom}`))))
}

function renderClaims(claims) {
  if (claims.length === 0) {
    return h('p', { className: 'fs-evidence-empty', 'data-evidence-claims': 'empty' },
      '没有 claims；空报告不等于「全部通过」。')
  }
  return h('ul', { className: 'fs-evidence-list', 'data-evidence-claims': 'true' },
    claims.map(claim => h('li', {
      key: `${claim.executionId ?? ''}\0${claim.id}`,
      className: 'fs-evidence-item',
      'data-evidence-claim': claim.id,
      'data-evidence-claim-conflict': claim.conflict === true ? 'true' : 'false',
    },
    h('div', { className: 'fs-evidence-item-head' },
      h('strong', null, textOf(claim.id) || '?'),
      h('span', { className: 'fs-view-badge' }, textOf(claim.type) || 'claim')),
    h('div', { className: 'fs-evidence-item-body' },
      h('span', null, 'value: '),
      h('code', null, claimValueText(claim.value)),
      h('span', { className: 'fs-evidence-note' }, '（报告自述，不是宿主结论）')),
    h('div', { className: 'fs-evidence-meta' },
      `来源 execution ${textOf(claim.executionId) || '未知'}`
        + ` · 引用${claim.refsChecked === true ? '已全部核对' : '未全部核对'}`),
    renderRefs(claim.refs))))
}

function renderFindings(findings) {
  if (findings.length === 0) {
    return h('p', { className: 'fs-evidence-empty', 'data-evidence-findings': 'empty' },
      '没有 findings。')
  }
  return h('ul', { className: 'fs-evidence-list', 'data-evidence-findings': 'true' },
    findings.map(finding => {
      const badge = findingBadge(finding)
      return h('li', {
        key: `${finding.executionId ?? ''}\0${finding.id}`,
        className: 'fs-evidence-item',
        'data-evidence-finding': finding.id,
        'data-evidence-finding-verified': finding.verified === true ? 'true' : 'false',
        'data-evidence-finding-conflict': finding.conflict === true ? 'true' : 'false',
      },
      h('div', { className: 'fs-evidence-item-head' },
        h('strong', null, textOf(finding.id) || '?'),
        h('span', {
          className: 'fs-evidence-badge ' + badge.tone,
          'data-evidence-badge': badge.tone,
        }, badge.text)),
      h('div', { className: 'fs-evidence-meta' },
        `来源 execution ${textOf(finding.executionId) || '未知'}`
          + ` · 引用${finding.refsChecked === true ? '已全部核对' : '未全部核对'}`
          + ' · 结论：报告自述（未经宿主业务裁决）'),
      renderRefs(finding.refs))
    }))
}

/** 实例详情「证据」面板。 */
export function InstanceEvidencePanel(props = {}) {
  const React = rt.React
  if (!React) throw new Error('InstanceEvidencePanel 需要先由宿主注入 React（bindReact）')
  const { useEffect, useState } = React
  const useCallback = typeof React.useCallback === 'function' ? React.useCallback : fn => fn
  const client = props.client && typeof props.client.readInstanceEvidence === 'function' ? props.client : null
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
      .then(() => client.readInstanceEvidence(instanceId))
      .then(data => {
        if (cancelled) return
        setPayload(isObject(data) ? data : null)
      })
      .catch(error => {
        if (cancelled) return
        setErrorText(evidenceFailurePlan(error).text)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [client, instanceId, tick])

  const refresh = useCallback(() => setTick(current => current + 1), [])
  const sections = evidenceSections(payload)
  const dataQuality = sections === null ? {} : sections.dataQuality
  const empty = instanceId === '' && sections === null
  const unsupported = client === null && instanceId !== ''

  return h('section', {
    className: 'fs-evidence',
    'aria-label': '实例证据',
    'data-evidence-panel': instanceId,
  },
  h('div', { className: 'fs-evidence-head' },
    h('strong', null, '证据'),
    h('span', { className: 'fs-evidence-note' }, '不产出总评级'),
    h('button', {
      type: 'button',
      className: 'fs-btn sm ghost',
      disabled: loading || instanceId === '',
      title: '重新读取 GET /instances/<id>/evidence（纯读，不启动 runner）',
      'data-action': 'evidence-refresh',
      onClick: refresh,
    }, loading ? '读取中…' : '刷新证据')),

  empty
    ? h('p', { className: 'fs-evidence-empty' }, '选中实例后显示业务证据。')
    : null,
  unsupported
    ? h('p', { className: 'fs-evidence-empty', 'data-evidence-unsupported': 'true' }, '当前客户端没有证据接口（需要 Host 0.13.12+）。')
    : null,
  errorText !== ''
    ? h('div', { className: 'fs-evidence-error', role: 'alert', 'data-evidence-error': 'true' }, errorText)
    : null,
  loading && sections === null
    ? h('p', { className: 'fs-evidence-empty' }, '正在读取证据…')
    : null,

  sections !== null
    ? h('div', { className: 'fs-evidence-body', 'data-evidence-status': dataQuality.evidenceStatus ?? 'unknown' },
      h('div', { className: 'fs-evidence-badges' },
        h('span', { className: 'fs-evidence-badge neutral', 'data-evidence-status-badge': 'true' },
          evidenceStatusText(dataQuality.evidenceStatus)),
        dataQuality.stub === true
          ? h('span', { className: 'fs-evidence-badge stub', 'data-evidence-stub': 'true' }, '桩报告：不是真实质量通过')
          : null,
        dataQuality.unknown === true
          ? h('span', { className: 'fs-evidence-badge warn', 'data-evidence-unknown': 'true' }, 'unknown')
          : null),
      h('dl', { className: 'fs-evidence-facts' },
        fact('报告 / 已解析', `${dataQuality.reportCount ?? 0} / ${dataQuality.parsedReportCount ?? 0}`, 'reportCount'),
        fact('claims / findings', `${dataQuality.claimCount ?? 0} / ${dataQuality.findingCount ?? 0}`, 'counts'),
        fact('已核对引用', String(dataQuality.verifiedRefCount ?? 0), 'verifiedRefCount'),
        fact('缺失 / 冲突', `${dataQuality.missingCount ?? 0} / ${dataQuality.conflictCount ?? 0}`, 'missingConflicts'),
        fact('快照缺失 / 工作区回落', `${dataQuality.snapshotMissing ?? 0} / ${dataQuality.workspaceFallbacks ?? 0}`, 'fallbacks')),
      renderReasonList(dataQuality.reasons),
      sections.sourceExecutions.length === 0
        ? null
        : h('div', { 'data-evidence-sources': 'true' },
          h('span', { className: 'fs-evidence-note' }, '来源 execution（各循环独立，不互相失效）：'),
          h('ul', { className: 'fs-evidence-list' },
            sections.sourceExecutions.map((source, index) => h('li', {
              key: `${source?.executionId ?? 'unknown'}\0${index}`,
              'data-evidence-source': source?.executionId ?? 'unknown',
            }, `${textOf(source?.executionId) || '未知 execution'}`
              + ` · 报告 ${Array.isArray(source?.reportPaths) ? source.reportPaths.join(' / ') : '—'}`)))),
      sections.missing.length === 0
        ? null
        : h('div', { className: 'fs-evidence-block', 'data-evidence-missing-list': 'true' },
          h('span', { className: 'fs-evidence-note' }, '缺失 / 未核对：'),
          h('ul', { className: 'fs-evidence-list' },
            sections.missing.map((item, index) => h('li', {
              key: `${item?.kind ?? 'item'}\0${item?.id ?? item?.path ?? index}`,
              'data-evidence-missing': item?.reason ?? 'unknown',
            }, `${item?.kind ?? 'item'} ${item?.id ?? item?.path ?? ''}：${evidenceReasonText(item?.reason)}（${item?.reason ?? 'unknown'}）`)))),
      sections.conflicts.length === 0
        ? null
        : h('div', { className: 'fs-evidence-block', 'data-evidence-conflicts-list': 'true' },
          h('span', { className: 'fs-evidence-note' }, '冲突：'),
          h('ul', { className: 'fs-evidence-list' },
            sections.conflicts.map((item, index) => h('li', {
              key: `${item?.kind ?? 'item'}\0${item?.id ?? item?.path ?? index}`,
              'data-evidence-conflict': item?.kind ?? 'unknown',
            }, `${item?.kind ?? 'conflict'} ${item?.id ?? item?.path ?? ''}：${evidenceReasonText(item?.kind)}`)))),
      h('div', { className: 'fs-evidence-block' },
        h('span', { className: 'fs-evidence-note' }, 'claims（报告自述）'),
        renderClaims(sections.claims)),
      h('div', { className: 'fs-evidence-block' },
        h('span', { className: 'fs-evidence-note' }, 'findings（fixed 只有复验引用全部核对后才显示 verified）'),
        renderFindings(sections.findings)),
      sections.verifiedRefs.length === 0
        ? null
        : h('div', { className: 'fs-evidence-block', 'data-evidence-verified-refs': 'true' },
          h('span', { className: 'fs-evidence-note' }, '已核对引用（只证明内容一致，不证明结论正确）：'),
          h('ul', { className: 'fs-evidence-list' },
            sections.verifiedRefs.map((ref, index) => h('li', {
              key: `${ref?.path ?? ''}\0${ref?.sha256 ?? ''}\0${index}`,
              'data-evidence-verified-ref': ref?.resolvedFrom ?? 'unknown',
            }, `${textOf(ref?.path) || '?'} · ${textOf(ref?.sha256).slice(0, 12)}… · ${ref?.resolvedFrom ?? '未知来源'}`)))))
    : null)
}
