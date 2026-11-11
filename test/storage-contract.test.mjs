/**
 * 存储契约：家目录解析的兜底口径。
 *
 * 回归 0.14.0 的部署缺陷：`resolveHome(env)` 省略 env 时必须回落到 `process.env`，
 * 否则 dsh 进程里 `HOME=/root` 而宿主用 `DSH_HOME` 注入家目录时，数据根会被解析到
 * `~/.dsh`——同一部署出现两套 definitions / instances 目录。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveHome, flowStudioDir, checkRunId, ID_PATTERN } from '../src/storage-contract.js'

test('resolveHome()：省略参数时读 process.env.DSH_HOME（容器 / 多 profile 部署）', () => {
  const previous = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = '/testbed/home'
    assert.equal(resolveHome(), '/testbed/home')
    assert.equal(flowStudioDir(), '/testbed/home/flow-studio')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('resolveHome({})：显式空 env 不读 process.env，回落 homedir', () => {
  const previous = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = '/should-be-ignored'
    assert.equal(resolveHome({}), join(homedir(), '.dsh'))
    assert.equal(resolveHome(null), '/should-be-ignored', 'null 等同于省略，按 process.env 解析')
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('resolveHome({DSH_HOME})：显式注入优先，空白视为未设置', () => {
  assert.equal(resolveHome({ DSH_HOME: '/x' }), '/x')
  assert.equal(resolveHome({ DSH_HOME: '  /y  ' }), '/y')
  assert.equal(resolveHome({ DSH_HOME: '   ' }), join(homedir(), '.dsh'))
})

test('checkRunId：合法 id 原样返回，非法返回 null', () => {
  assert.equal(checkRunId('i-abc_1.2'), 'i-abc_1.2')
  assert.equal(checkRunId('../etc/passwd'), null)
  assert.equal(checkRunId('a/b'), null)
  assert.equal(checkRunId('x'.repeat(65)), null)
  assert.equal(checkRunId(''), null)
  assert.equal(checkRunId(42), null)
  assert.ok(ID_PATTERN.test('flow-demo'))
})
