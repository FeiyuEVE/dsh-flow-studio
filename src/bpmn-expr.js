/**
 * FEEL 表达式安全求值与语言白名单。
 *
 * 0.13 的两条硬策略落在这一层（见 docs/plan/0.13-bpmn引擎与适配器.md §3.1）：
 *
 * 1. **只允许 FEEL**：`language="javascript"` 在 bpmn-engine 里走 `node:vm`，实测能
 *    逃逸到 `process`，不是沙箱；任何非 FEEL 语言一律拒绝。
 * 2. **可疑内容拒绝**：`process` / `require(` / `constructor` / `this` 是 JS 逃逸的
 *    标志性片段，出现即拒绝（哪怕调用方声明了 `language="feel"`）。
 *
 * **运行时前提**：流程条件的求值必须由本模块的 `evaluateFeel()` 负责，
 * **不能交给 bpmn-engine 内置表达式引擎**——它不会把 `= x` 当 FEEL，而是按属性
 * 路径解析，条件会静默恒真/恒假（研究实测，0.13 红线）。运行器注册表达式处理器时
 * 必须以本模块为唯一入口。
 *
 * 本模块是纯函数、不碰网络/文件系统；求值异常一律收敛成 `{ ok:false, error }`，
 * **绝不 throw**。feelin 的 `evaluate()` 收的是剥掉 Camunda 风格前缀 `=` 的表达式
 * 本体（冒烟已验），本模块统一负责剥前缀。
 *
 * @module @feiyueve/dsh-flow-studio/bpmn-expr
 */

import { evaluate } from './feelin-vendor.js'

/** FEEL 语言标识（大小写不敏感；也接受 FEEL 规范的 URI 形式）。 */
const FEEL_LANGUAGES = new Set([
  'feel',
  'feel-expression',
  'http://www.omg.org/spec/feel/20140401',
  'https://www.omg.org/spec/feel/20140401',
])

/**
 * 可疑内容黑名单。命中即拒绝——这是安全策略，不是语法检查。
 * 用词边界避免误伤 `processState` / `thisIsFine` 这类普通变量名。
 */
const UNSAFE_PATTERNS = [
  { token: 'process', re: /\bprocess\b/i, hint: 'process 是宿主进程对象，FEEL 不需要也不许访问' },
  { token: 'require(', re: /\brequire\s*\(/i, hint: 'require() 可以加载任意模块' },
  { token: 'constructor', re: /\bconstructor\b/i, hint: 'constructor 是原型链逃逸入口' },
  { token: 'this', re: /\bthis\b/i, hint: 'this 在 FEEL 里没有语义，通常意味着 JS 逃逸' },
]

/** 表达式语言是否是 FEEL（缺省语言视为「未声明」，由调用方决定是否补 = 前缀）。 */
export function isFeelLanguage(language) {
  if (language === undefined || language === null) return true
  if (typeof language !== 'string') return false
  const normalized = language.trim().toLowerCase()
  if (normalized === '') return true
  return FEEL_LANGUAGES.has(normalized)
}

/**
 * 去掉字符串字面量，只留下代码部分再做可疑片段匹配。
 * 这样 `= note = "this is fine"` 不会因为字符串里出现 `this` 被误杀，
 * 而 `= this.x` / `= require("fs")` 仍然会命中。
 */
function stripStringLiterals(text) {
  let output = ''
  let quote = null
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== null) {
      if (char === '\\') {
        index += 1
        continue
      }
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    output += char
  }
  return output
}

/** 构造一个结构化的失败结果（error/errors 两份，调用方按习惯取）。 */
function failure(code, message, extra = {}) {
  const error = { code, message, ...extra }
  return {
    ok: false,
    expression: null,
    body: null,
    language: null,
    error,
    errors: [error],
  }
}

/**
 * 校验一个条件表达式是否安全可求值。
 *
 * 接受两种入参：
 * - 字符串：表达式本体（可带 `=` 前缀，也可不带；feelin 两者都吃）；
 * - `{ expression | body, language }`：BPMN `conditionExpression` / 解析后的条件对象。
 *
 * @param {string | { expression?: string, body?: string, language?: string }} input
 * @returns {{
 *   ok: boolean,
 *   expression: string | null,
 *   body: string | null,
 *   language: string | null,
 *   error: null | { code: string, message: string, [key: string]: unknown },
 *   errors: Array<{ code: string, message: string, [key: string]: unknown }>,
 * }}
 */
export function assertFeelSafe(input) {
  let raw
  let language
  try {
    if (typeof input === 'string') {
      raw = input
    } else if (input && typeof input === 'object' && !Array.isArray(input)) {
      raw = typeof input.expression === 'string'
        ? input.expression
        : (typeof input.body === 'string' ? input.body : undefined)
      language = input.language
    } else {
      return failure('FEEL_INVALID_EXPRESSION', '表达式必须是字符串，或 { expression, language } 对象。')
    }
  } catch (error) {
    return failure('FEEL_INVALID_EXPRESSION', `表达式对象无法读取：${error?.message || String(error)}`)
  }

  if (typeof raw !== 'string') {
    return failure('FEEL_INVALID_EXPRESSION', '表达式本体必须是字符串。')
  }

  if (!isFeelLanguage(language)) {
    let languageLabel = '[unreadable]'
    try {
      languageLabel = typeof language === 'string' ? language : String(language)
    } catch {
      // 保持「绝不 throw」：连语言标签都读不出来时用占位符。
    }
    return failure(
      'FEEL_LANGUAGE_NOT_ALLOWED',
      `只允许 FEEL 表达式；拒绝 language=${JSON.stringify(languageLabel)}（javascript 走 node:vm，不是沙箱）。`,
      { language: languageLabel },
    )
  }

  const trimmed = raw.trim()
  if (trimmed === '') {
    return failure('FEEL_EMPTY_EXPRESSION', '表达式不能为空。')
  }

  const body = trimmed.startsWith('=') ? trimmed.slice(1).trim() : trimmed
  if (body === '') {
    return failure('FEEL_EMPTY_EXPRESSION', '表达式只有 `=` 前缀，没有可求值的本体。')
  }

  const codeOnly = stripStringLiterals(body)
  for (const rule of UNSAFE_PATTERNS) {
    if (rule.re.test(codeOnly)) {
      return failure(
        'FEEL_UNSAFE_CONTENT',
        `表达式包含可疑内容「${rule.token}」：${rule.hint}。`,
        { token: rule.token },
      )
    }
  }

  return {
    ok: true,
    expression: trimmed,
    body,
    language: 'feel',
    error: null,
    errors: [],
  }
}

/** 把 feelin 的警告收敛成可序列化的短对象（丢掉 AST 细节，保留 type/message）。 */
function normalizeWarnings(warnings) {
  if (!Array.isArray(warnings)) return []
  return warnings.map(item => ({
    type: typeof item?.type === 'string' ? item.type : 'FEEL_WARNING',
    message: typeof item?.message === 'string' ? item.message : String(item),
  }))
}

/**
 * 安全求值一个 FEEL 表达式。
 *
 * @param {string | { expression?: string, body?: string, language?: string }} expression
 * @param {Record<string, unknown> | null | undefined} variables
 * @returns {{
 *   ok: boolean,
 *   value: unknown,
 *   warnings: Array<{ type: string, message: string }>,
 *   error: null | { code: string, message: string, [key: string]: unknown },
 * }}
 */
export function evaluateFeel(expression, variables) {
  let safe
  try {
    safe = assertFeelSafe(expression)
  } catch (error) {
    return {
      ok: false,
      value: null,
      warnings: [],
      error: {
        code: 'FEEL_INVALID_EXPRESSION',
        message: `表达式无法读取：${error?.message || String(error)}`,
      },
    }
  }
  if (!safe.ok) {
    return { ok: false, value: null, warnings: [], error: safe.error }
  }

  let context = {}
  if (variables !== undefined && variables !== null) {
    if (typeof variables !== 'object' || Array.isArray(variables)) {
      return {
        ok: false,
        value: null,
        warnings: [],
        error: { code: 'FEEL_INVALID_VARIABLES', message: 'variables 必须是普通对象（FEEL context）。' },
      }
    }
    try {
      context = { ...variables }
    } catch (error) {
      return {
        ok: false,
        value: null,
        warnings: [],
        error: {
          code: 'FEEL_INVALID_VARIABLES',
          message: `variables 无法展开成 FEEL context：${error?.message || String(error)}`,
        },
      }
    }
  }

  let result
  try {
    result = evaluate(safe.body, context)
  } catch (error) {
    return {
      ok: false,
      value: null,
      warnings: [],
      error: {
        code: 'FEEL_EVALUATION_ERROR',
        message: error?.message || String(error),
        name: error?.name || 'Error',
      },
    }
  }

  // feelin 8.x 返回 { value, warnings }；兼容极老版本直接返回裸值的情况。
  const envelope = result
    && typeof result === 'object'
    && Array.isArray(result.warnings)
    && Object.prototype.hasOwnProperty.call(result, 'value')
  const rawValue = envelope ? result.value : result
  const warnings = normalizeWarnings(envelope ? result.warnings : [])

  return {
    ok: true,
    value: rawValue === undefined || rawValue === null ? null : rawValue,
    warnings,
    error: null,
  }
}
