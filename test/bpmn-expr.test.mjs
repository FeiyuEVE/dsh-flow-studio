#!/usr/bin/env node
/**
 * FEEL 表达式自检：求值、上下文、非法表达式不抛、JS 语言/逃逸片段被拒。
 *
 * 直接 `node test/bpmn-expr.test.mjs`；不启动 dsh、不写盘。
 */

import assert from 'node:assert/strict'

import { assertFeelSafe, evaluateFeel, isFeelLanguage } from '../src/bpmn-expr.js'

let checks = 0
let assertions = 0

/** 断言小包装：统一计数，末尾打印「N 组通过（M 条断言）」。 */
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
  includes(haystack, needle, message) {
    assertions += 1
    assert.ok(
      typeof haystack === 'string' && haystack.includes(needle),
      message || `期望包含「${needle}」，实际：${haystack}`,
    )
  },
}

function check(name, fn) {
  fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

console.log('bpmn-expr.js')

check('= 1 + 1 → 2（自动剥掉 = 前缀）', () => {
  const result = evaluateFeel('= 1 + 1', {})
  A.equal(result.ok, true)
  A.equal(result.value, 2)
  A.deepEqual(result.warnings, [])
  A.equal(result.error, null)
})

check('= false → false（布尔不被归一化成 null）', () => {
  const result = evaluateFeel('= false', {})
  A.equal(result.ok, true)
  A.equal(result.value, false)
})

check('variables 包成 FEEL context：= amount > 1', () => {
  const result = evaluateFeel('= amount > 1', { amount: 2 })
  A.equal(result.ok, true)
  A.equal(result.value, true)

  const missing = evaluateFeel('= amount > 1', {})
  A.equal(missing.ok, true)
  A.equal(missing.value, null, '变量缺失时 feelin 返回 null')
  A.ok(missing.warnings.length > 0, '变量缺失必须留下 warning')
  A.includes(missing.warnings[0].message, 'amount')
})

check('= null → ok:true, value:null', () => {
  const result = evaluateFeel('= null', {})
  A.equal(result.ok, true)
  A.equal(result.value, null)
})

check('非法表达式 → ok:false 且绝不 throw', () => {
  let result
  assert.doesNotThrow(() => {
    result = evaluateFeel('= 1 +', {})
  }, 'evaluateFeel 不能把 feelin 的语法错误抛给调用方')
  A.equal(result.ok, false)
  A.equal(result.value, null)
  A.ok(result.error && result.error.code === 'FEEL_EVALUATION_ERROR')
  A.includes(result.error.message, 'Incomplete')
})

check('非字符串 / 空表达式 → 结构化错误', () => {
  const nonString = evaluateFeel({ language: 'feel' }, {})
  A.equal(nonString.ok, false)
  A.equal(nonString.error.code, 'FEEL_INVALID_EXPRESSION')

  const empty = evaluateFeel('   ', {})
  A.equal(empty.ok, false)
  A.equal(empty.error.code, 'FEEL_EMPTY_EXPRESSION')

  const onlyEquals = evaluateFeel('=   ', {})
  A.equal(onlyEquals.ok, false)
  A.equal(onlyEquals.error.code, 'FEEL_EMPTY_EXPRESSION')
})

check('language=javascript 被拒（安全策略反例）', () => {
  const result = evaluateFeel({ expression: '= 1 + 1', language: 'javascript' }, {})
  A.equal(result.ok, false)
  A.equal(result.error.code, 'FEEL_LANGUAGE_NOT_ALLOWED')
  A.equal(result.value, null)

  const safe = assertFeelSafe({ expression: '= 1 + 1', language: 'javascript' })
  A.equal(safe.ok, false)
  A.equal(safe.errors.length, 1)
})

check('可疑内容 process / require( / constructor / this 被拒', () => {
  for (const body of ['= process.exit(1)', '= require("fs")', '= user.constructor', '= this.x']) {
    const result = assertFeelSafe(body)
    A.equal(result.ok, false, `应当拒绝：${body}`)
    A.equal(result.error.code, 'FEEL_UNSAFE_CONTENT', `应当命中安全策略：${body}`)
  }
})

check('字符串字面量里的同名词不误伤（= note = "this is fine"）', () => {
  const result = assertFeelSafe('= note = "this is fine"')
  A.equal(result.ok, true, '字符串字面量里的 this 不应算可疑内容')
  const evaluated = evaluateFeel('= note = "this is fine"', { note: 'this is fine' })
  A.equal(evaluated.ok, true)
  A.equal(evaluated.value, true)
})

check('语言白名单：feel / FEEL / FEEL URI 接受，groovy 拒绝', () => {
  A.equal(isFeelLanguage('feel'), true)
  A.equal(isFeelLanguage('FEEL'), true)
  A.equal(isFeelLanguage('http://www.omg.org/spec/FEEL/20140401'), true)
  A.equal(isFeelLanguage('javascript'), false)
  A.equal(isFeelLanguage('groovy'), false)
  A.equal(isFeelLanguage(undefined), true, '未声明语言由调用方决定是否要求 = 前缀')

  const feel = assertFeelSafe({ expression: '= 1', language: 'FEEL' })
  A.equal(feel.ok, true)
  A.equal(feel.body, '1')

  const groovy = assertFeelSafe({ expression: '= 1', language: 'groovy' })
  A.equal(groovy.ok, false)
  A.equal(groovy.error.code, 'FEEL_LANGUAGE_NOT_ALLOWED')
})

check('variables 不是普通对象 → 结构化错误', () => {
  const arrayVars = evaluateFeel('= 1', [])
  A.equal(arrayVars.ok, false)
  A.equal(arrayVars.error.code, 'FEEL_INVALID_VARIABLES')

  const stringVars = evaluateFeel('= 1', 'nope')
  A.equal(stringVars.ok, false)
  A.equal(stringVars.error.code, 'FEEL_INVALID_VARIABLES')
})

console.log(`\n${checks} 组通过（${assertions} 条断言）`)
