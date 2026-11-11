#!/usr/bin/env node
/**
 * 把 bpmn.io 的官方 CSS 收敛成**一个自包含字符串**，供画布 chunk（lib/client.bpmn.js）
 * 直接内联注入：
 *
 *   diagram-js/assets/diagram-js.css
 *   bpmn-js/dist/assets/bpmn-js.css
 *   bpmn-js/dist/assets/bpmn-font/css/bpmn.css
 *   @bpmn-io/properties-panel/dist/assets/properties-panel.css
 *
 * 三条硬约束（0.13.3 步骤 4）：
 *   1. 字体只留 woff2，并以 base64 `data:` 内联 —— 宿主 assets 路由只支持图片，
 *      `.woff2` 走不通；`bpmn.css` 里 eot/woff/ttf/svg 分支全部丢弃；
 *   2. 处理完的 CSS 里**不允许再出现任何非 `data:` 的 `url(...)`**，否则构建失败：
 *      否则线上会悄悄多发 CSS/字体请求；
 *   3. 产物是普通 ESM 模块 `src/client/bpmn/assets.generated.js`，只被 chunk import。
 *      文件是构建产物（.gitignore），提交源码里不带这坨 base64。
 *
 * 用法：
 *   node scripts/build-bpmn-assets.mjs
 * 或在 scripts/build.mjs 里调用 buildBpmnAssets()（构建前自动执行）。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const defaultRoot = resolve(here, '..')

/** 官方样式表，顺序即层叠顺序（diagram-js 基础 → bpmn-js → 字体 → 属性面板）。 */
export const BPMN_STYLESHEETS = [
  { name: 'diagram-js', path: 'node_modules/diagram-js/assets/diagram-js.css' },
  { name: 'bpmn-js', path: 'node_modules/bpmn-js/dist/assets/bpmn-js.css' },
  { name: 'bpmn-font', path: 'node_modules/bpmn-js/dist/assets/bpmn-font/css/bpmn.css' },
  { name: 'properties-panel', path: 'node_modules/@bpmn-io/properties-panel/dist/assets/properties-panel.css' },
]

/** 生成文件位置：chunk 通过相对 import 读取；.gitignore 排除。 */
export const BPMN_ASSETS_MODULE = 'src/client/bpmn/assets.generated.js'

/** 去掉 query/hash，便于按真实文件读取。 */
function cleanAssetPath(url) {
  const cut = url.search(/[?#]/)
  return cut >= 0 ? url.slice(0, cut) : url
}

/** 把 `url(...)` 里的相对路径替换成 data URI；只接受 woff2。 */
function inlineFontUrl(cssFile, dir, rawUrl) {
  const url = cleanAssetPath(rawUrl.trim())
  if (url.startsWith('data:')) return rawUrl
  if (!/\.woff2$/i.test(url)) {
    throw new Error(
      `bpmn 资源内联失败：${cssFile} 里还有非 woff2 的外部资源 url(${rawUrl})；`
      + '只允许内联 woff2 或 data: URI。',
    )
  }
  const fontPath = resolve(dir, url)
  const data = readFileSync(fontPath)
  return `data:font/woff2;base64,${data.toString('base64')}`
}

/**
 * 处理单个样式表：
 * - 去注释（同时干掉 bpmn.css 里注释掉的 svg 备用 @font-face）；
 * - @font-face 只保留内联 woff2 的一个 src；
 * - 校验没有残留外部 url()。
 */
export function inlineStylesheet(cssFile, cssText) {
  const dir = dirname(cssFile)
  let css = String(cssText)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@charset[^;]*;/gi, '')

  css = css.replace(/@font-face\s*\{([^}]*)\}/gi, (block, body) => {
    const family = /font-family\s*:\s*([^;]+);?/i.exec(body)
    const weight = /font-weight\s*:\s*([^;]+);?/i.exec(body)
    const style = /font-style\s*:\s*([^;]+);?/i.exec(body)
    const display = /font-display\s*:\s*([^;]+);?/i.exec(body)
    const woff2 = /url\(\s*(['"]?)([^'")]+\.woff2(?:[?#][^'")]*)?)\1\s*\)/i.exec(body)
    if (!woff2) return ''
    const dataUrl = inlineFontUrl(cssFile, dir, woff2[2])
    return '@font-face{'
      + (family ? `font-family:${family[1].trim()};` : '')
      + `src:url("${dataUrl}") format('woff2');`
      + (weight ? `font-weight:${weight[1].trim()};` : 'font-weight:normal;')
      + (style ? `font-style:${style[1].trim()};` : 'font-style:normal;')
      + (display ? `font-display:${display[1].trim()};` : '')
      + '}'
  })

  // 剩余 url() 只允许 data:；相对路径 / http(s) 一律拒绝，构建期就失败。
  for (const match of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
    const raw = match[2].trim()
    if (raw.startsWith('data:')) continue
    throw new Error(
      `bpmn 资源内联失败：${cssFile} 里残留外部 url(${raw})；` +
      '样式必须自包含，不能额外请求 CSS/字体。',
    )
  }

  return css.replace(/\r\n/g, '\n').trim() + '\n'
}

/**
 * 生成 `src/client/bpmn/assets.generated.js`。
 *
 * @param {string} [root] 仓库根目录
 * @returns {{ modulePath: string, cssBytes: number, fontCount: number, files: string[] }}
 */
export function buildBpmnAssets(root = defaultRoot) {
  const parts = []
  const files = []
  let fontCount = 0
  for (const sheet of BPMN_STYLESHEETS) {
    const file = resolve(root, sheet.path)
    const raw = readFileSync(file, 'utf8')
    const css = inlineStylesheet(file, raw)
    fontCount += (css.match(/data:font\/woff2;base64,/g) || []).length
    files.push(sheet.path)
    parts.push(`/* ===== ${sheet.name}: ${sheet.path} ===== */\n${css}`)
  }

  const combined = parts.join('\n')
  const modulePath = resolve(root, BPMN_ASSETS_MODULE)
  const source = [
    '// 构建产物：由 scripts/build-bpmn-assets.mjs 生成，不要手改，也不要提交。',
    '// 官方 CSS + 内联 woff2 字体（bpmn-js / diagram-js / @bpmn-io/properties-panel）。',
    `export const BPMN_ASSETS_CSS = ${JSON.stringify(combined)};`,
    '',
  ].join('\n')
  writeFileSync(modulePath, source)

  return { modulePath, cssBytes: Buffer.byteLength(combined), fontCount, files }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const result = buildBpmnAssets()
  console.log(
    `✓ bpmn 资源内联：${result.files.length} 个样式表，${result.fontCount} 个 woff2 base64，`
    + `CSS ${result.cssBytes} 字节 → ${BPMN_ASSETS_MODULE}`,
  )
}
