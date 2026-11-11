/**
 * 左侧定义列表（0.13.3 步骤 5）。
 *
 * 旧版这里是「流程模板 + 运行记录」双列表；页面切到 BPMN 定义域后只保留
 * **定义列表**：
 *
 * - 列表来自 `GET /definitions`（`{definitions:[…]}`），本地只做形状收敛；
 * - 每行显示名称 / id / 最新版本 / 版本数，选中行带 `data-active`；
 * - 新建、导入、从模板新建都由页面注入回调，组件本身不碰 `fetch` / `FileReader`；
 * - 完全受控、无 hooks：SSR 与真实浏览器渲染同一份结构。
 *
 * @module @feiyueve/dsh-flow-studio/client/flowlist
 */

import { h } from './runtime.js'

/** 没有定义时的可操作空态（不是空白）。 */
export const DEFINITION_LIST_EMPTY_TEXT = '还没有定义：新建、导入，或从模板开始。'

/** 正整数（版本号）或 null。 */
function positiveInt(value) {
  if (Number.isSafeInteger(value) && value >= 1) return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim())
    if (Number.isSafeInteger(parsed) && parsed >= 1) return parsed
  }
  return null
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 归一化一行定义（列表接口 / 详情接口同形，缺字段给安全默认值）。
 * @param {object} entry
 * @returns {{id: string, name: string, description: string, latestVersion: number|null,
 *   latestHash: string, versionCount: number, updatedAt: string}}
 */
export function normalizeDefinitionRow(entry) {
  if (!isObject(entry)) {
    return {
      id: '', name: '', description: '', latestVersion: null,
      latestHash: '', versionCount: 0, updatedAt: '',
    }
  }
  const versions = Array.isArray(entry.versions) ? entry.versions : []
  const latestVersion = positiveInt(entry.latestVersion)
  return {
    id: typeof entry.id === 'string' ? entry.id : '',
    name: typeof entry.name === 'string' && entry.name.trim() !== ''
      ? entry.name.trim()
      : (typeof entry.id === 'string' ? entry.id : ''),
    description: typeof entry.description === 'string' ? entry.description : '',
    latestVersion,
    latestHash: typeof entry.latestHash === 'string' ? entry.latestHash : '',
    versionCount: Number.isSafeInteger(entry.versionCount) && entry.versionCount >= 0
      ? entry.versionCount
      : (latestVersion === null ? versions.length : Math.max(versions.length, latestVersion)),
    updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
  }
}

/**
 * `GET /definitions` 信封 / 裸数组 → 行数组（丢掉没有 id 的坏行）。
 * @param {object|object[]|null|undefined} payload
 */
export function definitionsFromPayload(payload) {
  const list = Array.isArray(payload)
    ? payload
    : (isObject(payload) && Array.isArray(payload.definitions) ? payload.definitions : [])
  const rows = []
  const seen = new Set()
  for (const entry of list) {
    const row = normalizeDefinitionRow(entry)
    if (row.id === '' || seen.has(row.id)) continue
    seen.add(row.id)
    rows.push(row)
  }
  return rows
}

/** 行的版本摘要：`v2 · 2 个版本`；没有版本时 `未保存版本`。 */
export function versionSummary(row) {
  if (!isObject(row) || row.latestVersion === null) return '未保存版本'
  const count = Number.isSafeInteger(row.versionCount) ? row.versionCount : 1
  return `v${row.latestVersion} · ${count} 个版本`
}

/** 行的可选描述：description 优先，其次 id。 */
export function definitionSubText(row) {
  if (!isObject(row)) return ''
  if (row.description) return row.description
  return row.id || ''
}

/** 在列表里找某份定义；找不到返回 null。 */
export function findDefinition(rows, id) {
  if (!Array.isArray(rows) || typeof id !== 'string' || id === '') return null
  return rows.find(row => row && row.id === id) || null
}

/**
 * 定义列表组件（受控）。
 *
 * props:
 * - `definitions`：{@link definitionsFromPayload} 的行数组；
 * - `activeId`：当前打开的定义 id；
 * - `busy`：操作进行中（禁用新建 / 导入 / 模板）；
 * - `templates`：`listTemplates()` 的输出；
 * - `onOpen(id)` / `onNew()` / `onImport(file)` / `onTemplate(templateId)`；
 * - `onRefresh()`。
 */
export function DefinitionList(props = {}) {
  const definitions = Array.isArray(props.definitions) ? props.definitions : []
  const templates = Array.isArray(props.templates) ? props.templates : []
  const busy = props.busy === true
  const onOpen = typeof props.onOpen === 'function' ? props.onOpen : () => {}
  const onNew = typeof props.onNew === 'function' ? props.onNew : () => {}
  const onImport = typeof props.onImport === 'function' ? props.onImport : () => {}
  const onTemplate = typeof props.onTemplate === 'function' ? props.onTemplate : () => {}
  const onRefresh = typeof props.onRefresh === 'function' ? props.onRefresh : () => {}

  const handleFile = event => {
    const input = event && event.target
    const file = input && input.files && input.files[0]
    if (file) onImport(file)
    if (input) {
      try { input.value = '' } catch { /* 只读文件控件，忽略 */ }
    }
  }

  return h('aside', {
    className: 'fs-def-list',
    'aria-label': '流程定义列表',
    'data-definition-count': String(definitions.length),
  },
  h('div', { className: 'fs-def-head' },
    h('strong', { className: 'fs-def-title' }, '定义'),
    h('div', { className: 'fs-def-actions' },
      h('button', {
        type: 'button', className: 'fs-btn sm', disabled: busy,
        onClick: onNew, 'data-action': 'new-definition',
      }, '新建'),
      h('label', { className: 'fs-btn sm fs-def-import', title: '导入本地 .bpmn / .xml 文件' },
        '导入',
        h('input', {
          type: 'file',
          className: 'fs-def-import-input',
          accept: '.bpmn,.xml,application/xml,text/xml',
          onChange: handleFile,
          disabled: busy,
          'aria-label': '导入 BPMN 文件',
          'data-action': 'import-definition',
        }),
      ),
      h('select', {
        className: 'fs-def-template',
        value: '',
        disabled: busy,
        'aria-label': '从模板新建定义',
        'data-action': 'template-definition',
        onChange: event => {
          const id = event && event.target ? event.target.value : ''
          if (id) onTemplate(id)
        },
      },
      h('option', { value: '' }, '模板'),
      ...templates.map(template => h('option', { key: template.id, value: template.id }, template.name))),
    )),
  h('div', { className: 'fs-def-list-tools' },
    h('span', { className: 'fs-def-count' }, `${definitions.length} 份定义`),
    h('button', {
      type: 'button', className: 'fs-btn sm ghost', onClick: onRefresh, disabled: busy,
      title: '重新读取定义列表',
    }, '刷新')),
  definitions.length === 0
    ? h('p', { className: 'fs-def-empty' }, DEFINITION_LIST_EMPTY_TEXT)
    : h('ul', { className: 'fs-def-rows' },
      definitions.map(row => h('li', { key: row.id },
        h('button', {
          type: 'button',
          className: 'fs-def-row' + (row.id === props.activeId ? ' active' : ''),
          'data-definition-id': row.id,
          'data-active': row.id === props.activeId ? 'true' : 'false',
          'data-version': row.latestVersion === null ? '' : String(row.latestVersion),
          title: row.id,
          onClick: () => onOpen(row.id),
        },
        h('span', { className: 'fs-def-row-name' }, row.name || row.id),
        h('span', { className: 'fs-def-row-meta' }, versionSummary(row)),
        definitionSubText(row) !== row.name
          ? h('span', { className: 'fs-def-row-sub' }, definitionSubText(row))
          : null,
        )))),
  )
}
