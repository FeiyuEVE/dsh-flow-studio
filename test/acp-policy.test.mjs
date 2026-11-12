#!/usr/bin/env node
/**
 * ACP 配置与权限判定自检（0.15 ACP P3）。
 *
 * 只覆盖 `src/acp-policy.js` 的纯逻辑：
 *   - `FLOW_STUDIO_ACP_CONFIG` 默认值 / 合法配置 / 未知键 / 非法 JSON / 类型与值域；
 *   - `selectAcpMode` 必须命中 `availableModes`，否则 `ACP_MODE_UNAVAILABLE`；
 *   - `chooseAcpPermission`：deny→reject_once、allow→allow_once、永不 always、
 *     不看 name、session 必须匹配、取消/无匹配回 cancelled、optionId 原样。
 *
 * 跑：`node test/acp-policy.test.mjs`（不联网、不依赖 dsh）。
 */

import assert from 'node:assert/strict'

import {
  ACP_CONFIG_ENV,
  ACP_CONFIG_INVALID,
  ACP_MODE_UNAVAILABLE,
  DEFAULT_ACP_CONFIG,
  chooseAcpPermission,
  parseAcpConfig,
  selectAcpMode,
} from '../src/acp-policy.js'

let checks = 0
let assertions = 0

const A = {
  equal(actual, expected, message) {
    assertions += 1
    assert.equal(actual, expected, message)
  },
  deepEqual(actual, expected, message) {
    assertions += 1
    assert.deepEqual(actual, expected, message)
  },
  ok(value, message) {
    assertions += 1
    assert.ok(value, message)
  },
}

async function check(name, fn) {
  await fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

function invalidConfig(raw, label) {
  const result = parseAcpConfig(raw)
  A.equal(result.ok, false, `${label}：必须解析失败`)
  A.equal(result.code, ACP_CONFIG_INVALID, `${label}：错误码`)
  A.equal(result.error.code, ACP_CONFIG_INVALID, `${label}：error.code`)
  A.ok(typeof result.message === 'string' && result.message !== '', `${label}：有可读原因`)
  return result
}

function permissionParams({ sessionId = 's1', options = [] } = {}) {
  return { sessionId, toolCall: { toolCallId: 'tool-1', title: 'Run' }, options }
}

function selectedOption(result) {
  A.equal(result.outcome.outcome, 'selected', '必须选择某个 option')
  return result.outcome.optionId
}

function cancelled(result, label) {
  A.deepEqual(result, { outcome: { outcome: 'cancelled' } }, `${label}：回 cancelled`)
}

console.log('acp-policy.js')

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

await check('默认配置：省略 / null / 空串都是 {codex-acp, [], {}, workspace-write, deny}', () => {
  const saved = process.env[ACP_CONFIG_ENV]
  delete process.env[ACP_CONFIG_ENV]
  try {
    for (const raw of [undefined, null, '', '   ']) {
      const result = parseAcpConfig(raw)
      A.equal(result.ok, true, `raw=${JSON.stringify(raw)} 解析成功`)
      A.deepEqual(result.config, {
        command: 'codex-acp',
        args: [],
        env: {},
        mode: 'workspace-write',
        permissionPolicy: 'deny',
      }, `raw=${JSON.stringify(raw)} 默认值`)
    }
  } finally {
    if (saved !== undefined) process.env[ACP_CONFIG_ENV] = saved
  }
  A.equal(DEFAULT_ACP_CONFIG.command, 'codex-acp', '导出的默认 command')
  A.equal(DEFAULT_ACP_CONFIG.permissionPolicy, 'deny', '导出的默认 policy 是 deny')
})

await check('合法配置：command/args/env/mode/permissionPolicy 全部保留', () => {
  const raw = JSON.stringify({
    command: '/usr/local/bin/codex-acp',
    args: ['--profile', 'review mode'],
    env: { OPENAI_API_KEY: 'sk-test-value', LC_ALL: 'C.UTF-8' },
    mode: 'read-only',
    permissionPolicy: 'allow',
  })
  const result = parseAcpConfig(raw)
  A.equal(result.ok, true, '解析成功')
  A.deepEqual(result.config, {
    command: '/usr/local/bin/codex-acp',
    args: ['--profile', 'review mode'],
    env: { OPENAI_API_KEY: 'sk-test-value', LC_ALL: 'C.UTF-8' },
    mode: 'read-only',
    permissionPolicy: 'allow',
  }, '配置原样')
})

await check('只给部分键：其余字段保持默认', () => {
  const result = parseAcpConfig(JSON.stringify({ command: 'my-acp' }))
  A.equal(result.ok, true, '解析成功')
  A.deepEqual(result.config, {
    command: 'my-acp',
    args: [],
    env: {},
    mode: 'workspace-write',
    permissionPolicy: 'deny',
  }, '部分配置叠加默认值')
})

await check('非法 JSON / 非对象 / 非字符串：ACP_CONFIG_INVALID 且不回显原文', () => {
  const secretRaw = '{"command":"SECRET_JSON_CANARY"'
  const result = invalidConfig(secretRaw, '非法 JSON')
  A.ok(!JSON.stringify(result).includes('SECRET_JSON_CANARY'), '错误结果不含原始 JSON 片段')

  for (const raw of ['null', '"just-a-string"', '[1,2,3]', 'true']) {
    invalidConfig(raw, `顶层非对象 ${raw}`)
  }
  invalidConfig({ command: 'x' }, '非字符串输入')
  invalidConfig(42, '数字输入')
})

await check('未知键：ACP_CONFIG_INVALID，且不泄露未知键的值', () => {
  const result = invalidConfig(
    JSON.stringify({ command: 'codex-acp', timeoutMs: 30000, apiKey: 'UNKNOWN_VALUE_CANARY' }),
    '未知键 timeoutMs',
  )
  A.ok(!JSON.stringify(result).includes('UNKNOWN_VALUE_CANARY'), '未知键的值不泄露')
  A.ok(result.message.includes('timeoutMs'), '错误信息点名未知键')
})

await check('类型与值域：command/args/env/mode/permissionPolicy 逐项拒绝', () => {
  // command
  for (const command of ['', '   ', 42, true, 'bad\u0000name', 'bad\nname']) {
    invalidConfig(JSON.stringify({ command }), `command=${JSON.stringify(command)}`)
  }
  // args
  for (const args of ['x', 42, {}, [1], ['ok', null], ['ok', 2], ['a\u0000b']]) {
    invalidConfig(JSON.stringify({ args }), `args=${JSON.stringify(args)}`)
  }
  // env
  for (const env of ['x', 42, [], { A: 1 }, { A: null }, { 'BAD-NAME': 'x' }, { '': 'x' }]) {
    invalidConfig(JSON.stringify({ env }), `env=${JSON.stringify(env)}`)
  }
  // 内部 finish 变量禁止覆盖（大小写不敏感）。
  invalidConfig(JSON.stringify({ env: { FLOW_STUDIO_FINISH_SOCKET: '/tmp/x' } }), 'env 覆盖 finish socket')
  invalidConfig(JSON.stringify({ env: { flow_studio_finish_token: 'x' } }), 'env 覆盖 finish token')
  // 原型污染形状也必须拒绝（JSON 里 __proto__ 是自有键）。
  invalidConfig('{"env":{"__proto__":"x"}}', 'env 键 __proto__')
  // mode
  for (const mode of ['', '   ', 42, null, 'a'.repeat(200)]) {
    invalidConfig(JSON.stringify({ mode }), `mode=${JSON.stringify(mode)}`)
  }
  // permissionPolicy 只准 deny / allow，不认 mode / 大小写变体 / 布尔。
  for (const permissionPolicy of ['mode', 'ALLOW', 'allow ', 'Deny', true, null]) {
    invalidConfig(JSON.stringify({ permissionPolicy }), `permissionPolicy=${JSON.stringify(permissionPolicy)}`)
  }
})

// ---------------------------------------------------------------------------
// mode 选择
// ---------------------------------------------------------------------------

const MODES = {
  currentModeId: 'read-only',
  availableModes: [
    { id: 'read-only', name: 'Read-only', description: 'DESC_CANARY_READ_ONLY' },
    { id: 'workspace-write', name: 'Workspace access', description: 'DESC_CANARY_WORKSPACE' },
  ],
}

await check('selectAcpMode：目标 mode 必须出现在 availableModes', () => {
  const result = selectAcpMode(MODES, 'workspace-write')
  A.equal(result.ok, true, '命中')
  A.equal(result.modeId, 'workspace-write', 'modeId')
  A.equal(result.mode.name, 'Workspace access', '保留 name 便于诊断')
  A.ok(!JSON.stringify(result).includes('DESC_CANARY'), '不回显 description')
})

await check('selectAcpMode：接受 availableModes 数组形式', () => {
  const result = selectAcpMode(MODES.availableModes, 'read-only')
  A.equal(result.ok, true, '数组形式命中')
  A.equal(result.modeId, 'read-only', 'modeId')
})

await check('selectAcpMode：缺失 / 大小写不符 / 空列表 → ACP_MODE_UNAVAILABLE', () => {
  for (const requested of ['agent', 'Workspace-Write', '', undefined]) {
    const result = selectAcpMode(MODES, requested)
    A.equal(result.ok, false, `requested=${JSON.stringify(requested)} 必须失败`)
    A.equal(result.code, ACP_MODE_UNAVAILABLE, '错误码')
    A.ok(Array.isArray(result.availableModeIds), '带可用 mode id 列表')
    A.ok(!JSON.stringify(result).includes('DESC_CANARY'), '不回显 description')
  }
  const empty = selectAcpMode({ availableModes: [] }, 'read-only')
  A.equal(empty.ok, false, '空列表失败')
  A.equal(empty.code, ACP_MODE_UNAVAILABLE, '空列表错误码')
})

await check('selectAcpMode：modes 结构非法时不崩，直接 unavailable', () => {
  for (const modes of [undefined, null, {}, 'x', { availableModes: 'x' }]) {
    const result = selectAcpMode(modes, 'read-only')
    A.equal(result.ok, false, `modes=${JSON.stringify(modes)} 失败`)
    A.equal(result.code, ACP_MODE_UNAVAILABLE, '错误码')
  }
  // 非法条目被忽略，不阻塞合法条目。
  const mixed = selectAcpMode([
    null,
    { name: 'no id' },
    { id: '', name: 'empty' },
    { id: 'read-only', name: 'Read-only' },
  ], 'read-only')
  A.equal(mixed.ok, true, '非法条目被忽略')
  A.equal(mixed.modeId, 'read-only', '仍能命中合法条目')
})

// ---------------------------------------------------------------------------
// 权限判定
// ---------------------------------------------------------------------------

const ALL_OPTIONS = [
  { optionId: 'allow-always-id', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'allow-once-id', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject-always-id', name: 'Always reject', kind: 'reject_always' },
  { optionId: 'reject-once-id', name: 'Reject once', kind: 'reject_once' },
]

await check('deny：只选 reject_once，绝不选 reject_always', () => {
  const result = chooseAcpPermission(
    permissionParams({ options: ALL_OPTIONS }),
    { policy: 'deny', sessionId: 's1' },
  )
  A.equal(selectedOption(result), 'reject-once-id', 'deny 选 reject_once')
})

await check('allow：只选 allow_once，即使 allow_always 排在前面也不选', () => {
  const result = chooseAcpPermission(
    permissionParams({ options: ALL_OPTIONS }),
    { policy: 'allow', sessionId: 's1' },
  )
  A.equal(selectedOption(result), 'allow-once-id', 'allow 选 allow_once')
})

await check('deny + 只有 allow → cancelled；allow + 只有 always → cancelled', () => {
  cancelled(chooseAcpPermission(
    permissionParams({ options: [{ optionId: 'a', name: 'Allow', kind: 'allow_once' }] }),
    { policy: 'deny', sessionId: 's1' },
  ), 'deny 只有 allow_once')
  cancelled(chooseAcpPermission(
    permissionParams({ options: [{ optionId: 'a', name: 'Allow', kind: 'allow_always' }] }),
    { policy: 'allow', sessionId: 's1' },
  ), 'allow 只有 allow_always')
  cancelled(chooseAcpPermission(
    permissionParams({ options: [{ optionId: 'r', name: 'Reject', kind: 'reject_always' }] }),
    { policy: 'deny', sessionId: 's1' },
  ), 'deny 只有 reject_always')
})

await check('不按名称推断授权：name 说 allow，kind 是 always / 缺失都 cancelled', () => {
  cancelled(chooseAcpPermission(
    permissionParams({ options: [
      { optionId: 'by-name', name: 'Allow once (name says yes)', kind: 'allow_always' },
    ] }),
    { policy: 'allow', sessionId: 's1' },
  ), 'allow + name 暗示但 kind=allow_always')
  cancelled(chooseAcpPermission(
    permissionParams({ options: [{ optionId: 'by-name', name: 'allow_once', kind: 'other' }] }),
    { policy: 'allow', sessionId: 's1' },
  ), 'allow + kind 不认识的 name 冒充')
  // kind 才是唯一判据：name 说 reject，但 kind=allow_once，allow 仍可选。
  A.equal(selectedOption(chooseAcpPermission(
    permissionParams({ options: [{ optionId: 'kind-wins', name: 'Reject this', kind: 'allow_once' }] }),
    { policy: 'allow', sessionId: 's1' },
  )), 'kind-wins', 'kind 优先于 name')
})

await check('cancelled / 错 session / 漏传 session：一律 cancelled', () => {
  cancelled(chooseAcpPermission(
    permissionParams({ options: ALL_OPTIONS }),
    { policy: 'deny', cancelled: true, sessionId: 's1' },
  ), 'cancelled=true')
  cancelled(chooseAcpPermission(
    permissionParams({ sessionId: 'other', options: ALL_OPTIONS }),
    { policy: 'deny', sessionId: 's1' },
  ), '错 session')
  cancelled(chooseAcpPermission(
    permissionParams({ options: ALL_OPTIONS }),
    { policy: 'deny' },
  ), '漏传 expected session')
  cancelled(chooseAcpPermission(
    { sessionId: 's1', toolCall: {}, options: ALL_OPTIONS },
    { policy: 'deny', sessionId: '' },
  ), 'expected session 为空')
  cancelled(chooseAcpPermission(
    { toolCall: {}, options: ALL_OPTIONS },
    { policy: 'deny', sessionId: 's1' },
  ), '请求缺 sessionId')
  cancelled(chooseAcpPermission(
    { sessionId: 's1', toolCall: {}, options: 'x' },
    { policy: 'deny', sessionId: 's1' },
  ), 'options 不是数组')
  cancelled(chooseAcpPermission(null, { policy: 'deny', sessionId: 's1' }), 'params 为 null')
})

await check('默认策略是 deny（不是 allow）；optionId 原样回传', () => {
  const result = chooseAcpPermission(
    permissionParams({ options: ALL_OPTIONS }),
    { sessionId: 's1' },
  )
  A.equal(selectedOption(result), 'reject-once-id', '缺省 policy 走 deny')

  // 不 trim、不截断、不改写 optionId。
  const weirdId = '  opt / id with spaces  '
  A.equal(selectedOption(chooseAcpPermission(
    permissionParams({ options: [{ optionId: weirdId, name: 'Allow', kind: 'allow_once' }] }),
    { policy: 'allow', sessionId: 's1' },
  )), weirdId, 'optionId 原样')

  // 空 optionId 不选。
  cancelled(chooseAcpPermission(
    permissionParams({ options: [{ optionId: '', name: 'Allow', kind: 'allow_once' }] }),
    { policy: 'allow', sessionId: 's1' },
  ), '空 optionId')
})

console.log(`\nacp-policy.js：${checks} 项检查 / ${assertions} 条断言全部通过`)
