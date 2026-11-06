/**
 * 右侧检查器：选中节点 / 连线后的配置面板。
 *
 * 全部字段都是受控组件，改动经 onPatch* 回写整份流程；没有本地副本，
 * 所以画布上的改动与检查器永远一致。
 *
 * 分组按「它是什么人 / 它要干什么 / 用什么资源」三段，组间不画分隔线，
 * 只靠 24px 间距分组（Linear 式的分组语言）。
 *
 * @module @feiyueve/dsh-flow-studio/client/inspector
 */

import { EDGE_KIND, EXEC_MODE, LIMITS, NODE_KIND } from '../model.js'
import { h, rt } from './runtime.js'

/**
 * 外部执行器（07 §6）：默认 `dsh` 走节点会话；`codex` / `custom` 起外部进程。
 * 服务端只允许 `mode:'single'` 配外部执行器，保存时 400 —— 面板要在选的时候就拦住。
 */
export const EXECUTOR_KINDS = Object.freeze(['dsh', 'codex', 'custom'])
export const DEFAULT_EXECUTOR = 'dsh'
export const EXECUTOR_COMMAND_MAX = 2000

const EXECUTOR_OPTIONS = [
  { value: 'dsh', label: 'dsh（默认）' },
  { value: 'codex', label: 'codex' },
  { value: 'custom', label: 'custom' },
]

/**
 * 读节点上的执行器。旧数据没有该字段 → `dsh`；
 * 宿主 normalizeFlow 会把白名单外字段收进 `extras`（往返保存不丢），这里也认那份。
 */
export function executorOf(node) {
  const direct = node && typeof node.executor === 'string' ? node.executor.trim() : ''
  const extras = node && node.extras && typeof node.extras === 'object' && !Array.isArray(node.extras)
    ? node.extras
    : null
  const nested = extras && typeof extras.executor === 'string' ? extras.executor.trim() : ''
  const value = direct !== '' ? direct : nested
  return EXECUTOR_KINDS.includes(value) ? value : DEFAULT_EXECUTOR
}

/** 读 `executorCommand`（旧数据可能只有 extras 里的那一份）。 */
export function executorCommandOf(node) {
  const direct = node && typeof node.executorCommand === 'string' ? node.executorCommand : ''
  if (direct !== '') return direct
  const extras = node && node.extras && typeof node.extras === 'object' && !Array.isArray(node.extras)
    ? node.extras
    : null
  return extras && typeof extras.executorCommand === 'string' ? extras.executorCommand : ''
}

function Field({ label, hint, children }) {
  return h('div', { className: 'fs-field' },
    h('div', { className: 'fs-label' },
      h('span', null, label),
      hint ? h('span', { className: 'fs-hint' }, hint) : null),
    children)
}

function Segmented({ value, options, onChange }) {
  return h('div', { className: 'fs-seg' }, options.map(option =>
    h('button', {
      key: option.value,
      type: 'button',
      className: 'fs-seg-btn' + (value === option.value ? ' on' : ''),
      disabled: option.disabled === true,
      onClick: () => onChange(option.value),
      title: option.title || '',
    }, option.label)))
}

function SkillsPicker({ value, skills, onChange }) {
  const { useState } = rt.React
  const [filter, setFilter] = useState('')
  const selected = new Set(value)
  const keyword = filter.trim().toLowerCase()
  const visible = keyword === ''
    ? skills
    : skills.filter(skill => (skill.name + ' ' + skill.description).toLowerCase().includes(keyword))

  const toggle = name => {
    const next = new Set(selected)
    if (next.has(name)) next.delete(name)
    else if (next.size < LIMITS.skillsPerNode) next.add(name)
    else return
    onChange([...next])
  }

  return h('div', { className: 'fs-skills' },
    h('input', {
      className: 'fs-skills-filter',
      placeholder: '搜索 ' + skills.length + ' 个可用 skill…',
      value: filter,
      onChange: event => setFilter(event.target.value),
    }),
    h('div', { className: 'fs-skills-list' },
      skills.length === 0
        ? h('div', { className: 'fs-empty-panel', style: { padding: '12px 8px' } }, '当前 profile 没有已注册的 skill')
        : visible.length === 0
          ? h('div', { className: 'fs-empty-panel', style: { padding: '12px 8px' } }, '没有匹配的 skill')
          : visible.map(skill => h('label', { key: skill.name, className: 'fs-skill' },
            h('input', {
              type: 'checkbox',
              checked: selected.has(skill.name),
              onChange: () => toggle(skill.name),
            }),
            h('div', { style: { minWidth: 0 } },
              h('div', { className: 'fs-skill-name' }, skill.name),
              skill.description ? h('div', { className: 'fs-skill-desc' }, skill.description) : null)))))
}

function MemberCard({ member, index, onPatch, onRemove }) {
  return h('div', { className: 'fs-member-card' },
    h('div', { className: 'fs-member-card-head' },
      h('span', null, '子 agent ' + (index + 1)),
      h('span', { style: { flex: 1 } }),
      h('button', { type: 'button', className: 'fs-btn ghost sm', onClick: onRemove }, '移除')),
    h('input', {
      className: 'fs-input',
      placeholder: '名称，例如「接口实现」',
      value: member.name,
      onChange: event => onPatch({ name: event.target.value }),
    }),
    h('textarea', {
      className: 'fs-textarea',
      placeholder: '这个子 agent 的角色与分工',
      value: member.role,
      rows: 2,
      onChange: event => onPatch({ role: event.target.value }),
    }))
}

function NodeForm({ node, flow, skills, onPatch, onDelete, onAddMember, onPatchMember, onRemoveMember, onConnect, onNudge }) {
  const isStage = node.kind === NODE_KIND.STAGE
  const rejectEdges = flow.edges.filter(edge => edge.from === node.id && edge.kind === EDGE_KIND.REJECT)
  const targets = flow.nodes.filter(item => item.id !== node.id)
  const step = event => (event.shiftKey ? 20 : 4)
  const nudge = (dx, dy) => event => onNudge(dx * step(event), dy * step(event))
  // 07 §6：外部执行器。默认 dsh；非 dsh 时面板顶部就给出可见标识（不藏在高级设置里）。
  const executor = executorOf(node)
  const external = executor !== DEFAULT_EXECUTOR
  const command = executorCommandOf(node)
  const commandMissing = executor === 'custom' && command.trim() === ''
  const teamConflict = isStage && external && node.mode === EXEC_MODE.TEAM

  return h('div', { className: 'fs-panel-body' },
    external
      ? h('div', { className: 'fs-exec-banner', role: 'status' },
        h('span', { className: 'fs-exec-badge' }, '外部执行器'),
        h('span', null,
          '这个节点由 ' + executor + ' 在外部进程里跑，不走 dsh 节点会话。'
          + (teamConflict ? '当前是团队模式，开跑前要改成「单个 agent」。' : '')))
      : null,
    h('div', { className: 'fs-group' },
      h(Field, { label: '标题' },
        h('input', {
          className: 'fs-input',
          value: node.title,
          maxLength: LIMITS.titleLen,
          onChange: event => onPatch({ title: event.target.value }),
        })),
      h(Field, { label: node.kind === NODE_KIND.STAGE ? '负责的事' : '这个节点的职责', hint: '它要交付什么' },
        h('textarea', {
          className: 'fs-textarea',
          placeholder: isStage ? '例如：拆需求条目、写验收标准、列风险。' : '流程入口/出口做什么。',
          value: node.task,
          rows: 4,
          onChange: event => onPatch({ task: event.target.value }),
        })),
      h(Field, { label: '期望产物', hint: '下一节点靠它接手' },
        h('textarea', {
          className: 'fs-textarea',
          placeholder: '例如：需求清单 R1..Rn + 风险表',
          value: node.outputs,
          rows: 2,
          onChange: event => onPatch({ outputs: event.target.value }),
        }))),

    // 单指针 / 键盘替代：不拖拽也能连线，不拖拽也能移动（WCAG 2.2 拖动替代）。
    h('div', { className: 'fs-group' },
      h('div', { className: 'fs-group-title' }, '位置与连线'),
      h(Field, { label: '位置', hint: '点按微调；按住 Shift 步长 20px' },
        h('div', { className: 'fs-pos' },
          h('div', { className: 'fs-pos-val' }, 'X ' + Math.round(node.x) + ' · Y ' + Math.round(node.y)),
          h('div', { className: 'fs-pos-grid' },
            h('span', { className: 'fs-pos-gap', 'aria-hidden': true }),
            h('button', { type: 'button', className: 'fs-btn ghost sm fs-pos-btn', title: '上移（Shift 20px）', onClick: nudge(0, -1) }, '上'),
            h('span', { className: 'fs-pos-gap', 'aria-hidden': true }),
            h('button', { type: 'button', className: 'fs-btn ghost sm fs-pos-btn', title: '左移（Shift 20px）', onClick: nudge(-1, 0) }, '左'),
            h('span', { className: 'fs-pos-gap', 'aria-hidden': true }),
            h('button', { type: 'button', className: 'fs-btn ghost sm fs-pos-btn', title: '右移（Shift 20px）', onClick: nudge(1, 0) }, '右'),
            h('span', { className: 'fs-pos-gap', 'aria-hidden': true }),
            h('button', { type: 'button', className: 'fs-btn ghost sm fs-pos-btn', title: '下移（Shift 20px）', onClick: nudge(0, 1) }, '下'),
            h('span', { className: 'fs-pos-gap', 'aria-hidden': true })))),
      h(Field, { label: '连接到…', hint: '选中即建边；方向按上下游自动判定' },
        h('select', {
          className: 'fs-select',
          value: '',
          onChange: event => {
            const target = event.target.value
            if (target) onConnect(target)
          },
        },
        h('option', { value: '' }, targets.length > 0 ? '选择一个目标节点…' : '没有其他节点可连'),
        targets.map(item => h('option', { key: item.id, value: item.id }, '到 ' + item.title))))),

    isStage
      ? h('div', { className: 'fs-group' },
        h('div', { className: 'fs-group-title' },
          h('span', null, '谁来做'),
          external
            ? h('span', { className: 'fs-exec-badge', title: '这个节点由外部执行器运行，不建 dsh 节点会话' },
              '外部执行器 · ' + executor)
            : null),
        h(Field, { label: '执行器', hint: 'dsh 走节点会话；codex / custom 起外部进程' },
          h('select', {
            className: 'fs-select',
            value: executor,
            'aria-label': '执行器',
            onChange: event => onPatch({ executor: event.target.value }),
          },
          EXECUTOR_OPTIONS.map(option => h('option', { key: option.value, value: option.value }, option.label)))),
        // 与服务端校验一致（07 §6）：team 需要引擎观察成员会话，外部进程做不到。
        teamConflict
          ? h('div', { className: 'fs-field-error', role: 'alert' },
            h('span', null, '外部执行器只支持「单个 agent」模式'),
            h('button', {
              type: 'button',
              className: 'fs-btn ghost sm',
              onClick: () => onPatch({ mode: EXEC_MODE.SINGLE }),
            }, '改为「单个 agent」'))
          : null,
        executor === 'custom'
          ? h(Field, { label: '执行命令', hint: '必填 · ≤' + EXECUTOR_COMMAND_MAX + ' 字符' },
            h('input', {
              className: 'fs-input' + (commandMissing ? ' bad' : ''),
              placeholder: '例如：my-agent --cwd {cwd} --prompt {prompt}',
              value: command,
              maxLength: EXECUTOR_COMMAND_MAX,
              'aria-required': 'true',
              'aria-invalid': commandMissing ? 'true' : 'false',
              onChange: event => onPatch({ executorCommand: event.target.value }),
            }),
            commandMissing
              ? h('div', { className: 'fs-field-error' },
                'custom 执行器必须填执行命令，可用 {prompt} / {schema} / {cwd} 占位')
              : null)
          : null,
        h(Field, {
          label: '执行方式',
          hint: external
            ? '外部执行器下只能用「单个 agent」'
            : node.mode === EXEC_MODE.TEAM ? '主管先拆任务再分给子 agent' : '一个 agent 全包',
        },
        h(Segmented, {
          value: node.mode,
          options: [
            { value: EXEC_MODE.SINGLE, label: '单个 agent' },
            {
              value: EXEC_MODE.TEAM,
              label: '主管 + 子 agent',
              disabled: external,
              title: external ? '外部执行器只支持「单个 agent」模式' : '',
            },
          ],
          onChange: mode => onPatch({ mode }),
        })),
        h(Field, { label: '角色定位', hint: '它是什么人' },
          h('textarea', {
            className: 'fs-textarea',
            placeholder: '例如：资深需求分析师，擅长把模糊诉求拆成可验收的条目。',
            value: node.role,
            rows: 3,
            onChange: event => onPatch({ role: event.target.value }),
          })),
        node.mode === EXEC_MODE.TEAM
          ? h('div', { className: 'fs-field' },
            h('div', { className: 'fs-label' },
              h('span', null, '子 agent 分工'),
              h('button', {
                type: 'button',
                className: 'fs-btn ghost sm',
                disabled: node.team.length >= LIMITS.teamMembers,
                onClick: onAddMember,
              }, '+ 添加')),
            node.team.length === 0
              ? h('div', { className: 'fs-empty-panel', style: { padding: '10px 4px' } }, '还没配子 agent：主管会自己干完。')
              : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
                node.team.map((member, index) => h(MemberCard, {
                  key: index,
                  member,
                  index,
                  onPatch: patch => onPatchMember(index, patch),
                  onRemove: () => onRemoveMember(index),
                }))))
          : null)
      : null,

    isStage
      ? h('div', { className: 'fs-group' },
        h('div', { className: 'fs-group-title' }, '用什么资源'),
        h(Field, { label: '引用 skills', hint: node.skills.length > 0 ? '已选 ' + node.skills.length : '可选' },
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
            node.skills.length > 0
              ? h('div', { className: 'fs-chips' }, node.skills.map(name => h('span', { key: name, className: 'fs-chip' },
                name,
                h('button', {
                  type: 'button',
                  title: '移除',
                  onClick: () => onPatch({ skills: node.skills.filter(item => item !== name) }),
                }, '×'))))
              : null,
            h(SkillsPicker, { value: node.skills, skills, onChange: next => onPatch({ skills: next }) }))),
        h(Field, { label: '模型覆盖', hint: '留空跟随会话默认' },
          h('input', {
            className: 'fs-input',
            placeholder: '例如 deepseek-chat',
            value: node.model,
            onChange: event => onPatch({ model: event.target.value }),
          })),
        rejectEdges.length > 0
          ? h(Field, { label: '打回上限', hint: '超过就交给人工' },
            h('input', {
              className: 'fs-input num',
              type: 'number',
              min: 1,
              max: LIMITS.maxRounds,
              value: node.maxRounds,
              onChange: event => onPatch({ maxRounds: Math.max(1, Math.min(LIMITS.maxRounds, Number(event.target.value) || 1)) }),
            }))
          : null)
      : null,

    h('div', { className: 'fs-divider' }),
    h('button', { type: 'button', className: 'fs-btn danger', onClick: onDelete }, '删除这个节点'))
}

function EdgeForm({ edge, flow, onPatch, onDelete }) {
  const byId = new Map(flow.nodes.map(node => [node.id, node]))
  const from = byId.get(edge.from)
  const to = byId.get(edge.to)
  const isReject = edge.kind === EDGE_KIND.REJECT
  const sameTarget = flow.edges.filter(item => item.to === edge.to && item.id !== edge.id).length

  return h('div', { className: 'fs-panel-body' },
    h('div', { className: 'fs-group' },
      h(Field, { label: '连线' },
        h('div', { className: 'fs-hint', style: { fontSize: 13, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)' } },
          (from ? from.title : '?') + ' → ' + (to ? to.title : '?'))),
      h(Field, { label: '类型', hint: isReject ? '目标必须是上游' : '顺序推进' },
        h(Segmented, {
          value: edge.kind,
          options: [
            { value: EDGE_KIND.NEXT, label: '正常流转' },
            { value: EDGE_KIND.REJECT, label: '打回' },
          ],
          onChange: kind => onPatch({ kind, label: kind === EDGE_KIND.REJECT ? (edge.label || '打回') : '' }),
        })),
      isReject
        ? h(Field, { label: '打回说明', hint: '16 字以内，超了会截断' },
          h('input', {
            className: 'fs-input',
            placeholder: '例如：方案被打回',
            value: edge.label,
            maxLength: 60,
            onChange: event => onPatch({ label: event.target.value }),
          }))
        : null,
      isReject
        ? h('div', { className: 'fs-hint' },
          sameTarget > 0
            ? '这个节点已有 ' + sameTarget + ' 条打回线进入，本线会再占一个槽位。'
            : '打回线走画布下方航道，共 6 个槽位；第 7 条起并入最外航道并收起标签。')
        : null),

    h('div', { className: 'fs-divider' }),
    h('button', { type: 'button', className: 'fs-btn danger', onClick: onDelete }, '删除这条连线'))
}

export function Inspector({
  flow, selection, skills,
  onPatchNode, onPatchEdge, onDeleteNode, onDeleteEdge,
  onAddMember, onPatchMember, onRemoveMember, onConnect, onNudge,
  locked = false, lockReason = '',
}) {
  let title = '配置'
  let executorBadge = ''
  let body = h('div', { className: 'fs-empty-panel' },
    '点画布上的节点或连线来配置。',
    h('br'),
    '双击空白处新增节点，',
    h('br'),
    '从节点右侧圆点拖到另一个节点即可连线。')

  if (selection && selection.kind === 'node') {
    const node = flow.nodes.find(item => item.id === selection.id)
    if (node) {
      title = node.kind === NODE_KIND.STAGE ? '节点配置' : node.kind === NODE_KIND.START ? '开始节点' : '结束节点'
      const nodeExecutor = executorOf(node)
      if (nodeExecutor !== DEFAULT_EXECUTOR) executorBadge = nodeExecutor
      body = h(NodeForm, {
        node,
        flow,
        skills,
        onPatch: patch => onPatchNode(node.id, patch),
        onDelete: () => onDeleteNode(node.id),
        onAddMember,
        onPatchMember: (index, patch) => onPatchMember(node.id, index, patch),
        onRemoveMember: index => onRemoveMember(node.id, index),
        onConnect: targetId => onConnect(node.id, targetId),
        onNudge: (dx, dy) => onNudge(node.id, dx, dy),
      })
    }
  } else if (selection && selection.kind === 'edge') {
    const edge = flow.edges.find(item => item.id === selection.id)
    if (edge) {
      title = '连线配置'
      body = h(EdgeForm, {
        edge,
        flow,
        onPatch: patch => onPatchEdge(edge.id, patch),
        onDelete: () => onDeleteEdge(edge.id),
      })
    }
  }

  // M1：运行中锁结构 —— 整个表单进 disabled fieldset，并显式写出原因（不是静默失效）。
  return h('aside', { className: 'fs-panel' + (locked ? ' locked' : '') },
    h('div', { className: 'fs-panel-head' },
      h('span', { className: 'fs-panel-head-main' },
        h('span', null, title),
        executorBadge !== ''
          ? h('span', { className: 'fs-panel-exec-badge', title: '这个节点由外部执行器运行，不建 dsh 节点会话' },
            '外部执行器 · ' + executorBadge)
          : null),
      locked ? h('span', { className: 'fs-panel-lock-badge' }, '运行中已锁定') : null),
    locked
      ? h('div', { className: 'fs-lock-banner', role: 'status' },
        lockReason || '运行中已锁定结构：检查器编辑暂不可用，停止运行后恢复')
      : null,
    h('fieldset', {
      className: 'fs-panel-body',
      disabled: locked,
      'aria-label': locked ? '运行中已锁定，检查器编辑暂不可用' : '配置面板',
    }, body))
}
