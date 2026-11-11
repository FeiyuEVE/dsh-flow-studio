#!/usr/bin/env node
/**
 * 0.13.8 实例工作区面板的真浏览器验收（playwright-core + 本机 Chrome）。
 *
 * 为什么单独一个文件：主客户端面板不在 BPMN chunk 里，`client-bpmn.browser.test.mjs`
 * 只挂 chunk editor。这里用 esbuild 现场打一个**只含面板**的浏览器 bundle（React 内联），
 * 用真实 Chromium 验证：
 *   1. 配置 worktree 时路径 / 分支 / HEAD / dirty / 可清理性的 DOM；
 *   2. ACTIVE 时清理按钮真实 disabled + 原因可见；
 *   3. 危险操作二次确认、请求体带 expectedHead，409 保留服务端原因并进入页面 notice；
 *   4. 全局清理先 list + dryRun 预览，展示 orphan / planHash；409 PLAN_STALE 后禁止重发；
 *   5. 暗色 token 下颜色可用、窄窗口不横向溢出。
 *
 * 运行（需要先 npm run build，确保 styles / 源码可打包）：
 *   node test/client-worktree.browser.test.mjs
 *   BPMN_TEST_BROWSER=/usr/bin/google-chrome node test/client-worktree.browser.test.mjs
 *
 * 测试产物在 `.tmp/0.13.8/`（项目内临时目录），不占系统 /tmp。
 */

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'
import { chromium } from 'playwright-core'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(repoRoot, '.tmp', '0.13.8')
const chromePath = process.env.BPMN_TEST_BROWSER || '/usr/bin/google-chrome'
mkdirSync(outDir, { recursive: true })

let checks = 0
let assertions = 0

async function check(name, fn) {
  await fn()
  checks += 1
  console.log(`  ✓ ${name}`)
}

function ok(value, message) {
  assertions += 1
  assert.ok(value, message)
}

function eq(actual, expected, message) {
  assertions += 1
  assert.equal(actual, expected, message)
}

function match(value, pattern, message) {
  assertions += 1
  assert.match(value, pattern, message)
}

/** 面板 bundle 入口：React 内联，组件与样式都来自 src（与 lib 同源）。 */
const ENTRY_SOURCE = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { bindReact } from ${JSON.stringify(join(repoRoot, 'src/client/runtime.js'))}
import { InstanceWorktreePanel } from ${JSON.stringify(join(repoRoot, 'src/client/instance-worktree.js'))}
import { CSS } from ${JSON.stringify(join(repoRoot, 'src/client/styles.js'))}

bindReact(React)
const style = document.createElement('style')
style.textContent = CSS
document.head.appendChild(style)

let root = null
window.__mountWorktreePanel = props => {
  if (root) root.unmount()
  const host = document.getElementById('mount')
  host.innerHTML = ''
  root = createRoot(host)
  root.render(React.createElement('div', { className: 'fs-root' }, React.createElement(InstanceWorktreePanel, props)))
  return true
}
`

const TOKENS = `
:root{
  --dsw-alias-bg-base:#ffffff;
  --dsw-alias-bg-layer-1:#f5f6f8;
  --dsw-alias-bg-layer-2:#eceef2;
  --dsw-alias-label-primary:#1a1d23;
  --dsw-alias-label-secondary:#4a505a;
  --dsw-alias-label-tertiary:#737a85;
  --dsw-alias-label-primary-foreground:#ffffff;
  --dsw-alias-border-l1:#c5c9cf;
  --dsw-alias-border-l2:#e0e3e7;
  --dsw-alias-border-l3:#aeb4bc;
  --dsw-alias-border-l4:#8e959e;
  --dsw-alias-brand-primary:#0b6bcb;
  --dsw-alias-state-error-primary:#d92d20;
  --dsw-alias-state-warn-primary:#b26a00;
  --dsw-alias-state-success-primary:#12805c;
  --dsw-alias-state-business-primary:#0b6bcb;
  --dsw-alias-interactive-bg-hover:#eceef2;
  --dsw-font-family:"Noto Sans CJK SC",system-ui,-apple-system,"Segoe UI",sans-serif;
  --dsw-font-markdown-code-font-family:"JetBrains Mono",monospace;
  --dsw-radius-sm:6px;
  --dsw-radius-md:8px;
  --dsw-radius-panel:12px;
}
body[data-ds-dark-theme]{
  --dsw-alias-bg-base:#15171c;
  --dsw-alias-bg-layer-1:#1d2027;
  --dsw-alias-bg-layer-2:#252932;
  --dsw-alias-label-primary:#f2f4f7;
  --dsw-alias-label-secondary:#c4c9d1;
  --dsw-alias-label-tertiary:#98a0aa;
  --dsw-alias-label-primary-foreground:#15171c;
  --dsw-alias-border-l1:#3a3f48;
  --dsw-alias-border-l2:#2b2f37;
  --dsw-alias-border-l3:#4b525c;
  --dsw-alias-border-l4:#636b76;
  --dsw-alias-brand-primary:#5aa7ff;
  --dsw-alias-state-error-primary:#ff6b60;
  --dsw-alias-state-warn-primary:#e6a23c;
  --dsw-alias-state-success-primary:#3fbf8f;
  --dsw-alias-state-business-primary:#5aa7ff;
  --dsw-alias-interactive-bg-hover:#252932;
}
html,body{margin:0;padding:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family)}
#notice{min-height:24px;font-size:12px;color:var(--dsw-alias-label-secondary)}
#mount{max-width:340px}
`

const HARNESS_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>worktree panel harness</title>
<style>${TOKENS}</style></head>
<body>
<div id="notice" data-kind=""></div>
<div id="mount"></div>
<script src="/panel.bundle.js"></script>
</body></html>`

const HEAD = 'a'.repeat(40)
const PLAN_HASH = 'f'.repeat(64)

function worktreePayload(overrides = {}) {
  return {
    ok: true,
    id: 'i-1',
    configured: true,
    instanceStatus: 'COMPLETED',
    mode: 'worktree',
    workspaceId: 'abcdefabcdef',
    effectiveRoot: '/managed/worktrees/abcdefabcdef/i-1',
    cleanupPolicy: 'retain',
    worktree: {
      state: 'ok',
      path: '/managed/worktrees/abcdefabcdef/i-1',
      branch: 'flow-instance/i-1',
      head: HEAD,
      dirty: false,
      cleanable: true,
      reasons: [],
    },
    cleanable: true,
    ...overrides,
  }
}

function pruneList() {
  return {
    ok: true,
    worktrees: [
      { instanceId: 'i-1', workspaceId: 'abcdefabcdef', instanceStatus: 'COMPLETED', path: '/w/i-1', orphan: false },
      { instanceId: 'i-orphan', workspaceId: 'abcdefabcdef', instanceStatus: null, path: '/w/i-orphan', orphan: true },
    ],
    orphans: [{ instanceId: 'i-orphan' }],
    corrupt: [],
    scannedAt: '2026-11-12T00:00:00.000Z',
  }
}

function prunePreview() {
  return {
    ok: true,
    dryRun: true,
    planHash: PLAN_HASH,
    removable: 1,
    reported: 1,
    plan: {
      v: 1,
      entries: [
        { instanceId: 'i-1', workspaceId: 'abcdefabcdef', action: 'remove', reason: 'owned-terminal-clean', path: '/w/i-1', dirty: false, instanceStatus: 'COMPLETED' },
        { instanceId: 'i-orphan', workspaceId: 'abcdefabcdef', action: 'report', reason: 'no-ownership', path: '/w/i-orphan', dirty: null, instanceStatus: null },
      ],
    },
  }
}

/** 页面里构造桩 client：函数不能从 Node 传进去。 */
async function mountPanel(page, options) {
  await page.evaluate(async opts => {
    const notice = document.getElementById('notice')
    const setNotice = (kind, text) => {
      notice.dataset.kind = kind
      notice.textContent = kind + ': ' + text
    }
    window.__calls = []
    const payload = opts.payload
    const client = {
      async readInstanceWorktree(id) {
        window.__calls.push({ kind: 'read', id })
        return payload
      },
      async removeInstanceWorktree(id, body) {
        window.__calls.push({ kind: 'remove', id, body })
        if (opts.removeError) {
          const error = new Error(opts.removeError.error)
          error.status = opts.removeError.status
          error.code = opts.removeError.code
          error.data = opts.removeError
          throw error
        }
        return { ok: true, id, removed: true, branchRemoval: { removed: true, branch: 'flow-instance/i-1' } }
      },
      async removeInstanceWorktreeBranch(id) {
        window.__calls.push({ kind: 'branch', id })
        return { ok: true, id, branchRemoval: { removed: true, branch: 'flow-instance/i-1' } }
      },
      async listInstanceWorktrees() {
        window.__calls.push({ kind: 'list' })
        return opts.list
      },
      async pruneInstanceWorktrees(body) {
        window.__calls.push({ kind: 'prune', body })
        if (body && body.dryRun === false && opts.pruneError) {
          const error = new Error(opts.pruneError.error)
          error.status = opts.pruneError.status
          error.code = opts.pruneError.code
          error.data = opts.pruneError
          throw error
        }
        if (body && body.dryRun === false) {
          return { ok: true, dryRun: false, planHash: PLAN_HASH, removed: [{ instanceId: 'i-1' }], skipped: [] }
        }
        return opts.preview
      },
    }
    window.__mountWorktreePanel({
      client,
      instanceId: opts.instanceId,
      instanceStatus: opts.instanceStatus,
      notice: setNotice,
      onChanged: () => setNotice('changed', '列表已刷新'),
    })
  }, options)
}

function startServer(bundle) {
  const server = http.createServer((req, res) => {
    if (req.url === '/panel.bundle.js') {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' })
      res.end(bundle)
      return
    }
    if (req.url === '/' || req.url === '/harness.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(HARNESS_HTML)
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  return new Promise(resolveServer => {
    server.listen(0, '127.0.0.1', () => resolveServer(server))
  })
}

const entryPath = join(outDir, 'worktree-panel-entry.js')
writeFileSync(entryPath, ENTRY_SOURCE, 'utf8')

const built = await build({
  entryPoints: [entryPath],
  absWorkingDir: repoRoot,
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  target: ['chrome110'],
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'silent',
})
const bundle = built.outputFiles[0].text
ok(bundle.includes('worktree-remove'), '面板 bundle 含工作区操作标记')
ok(!bundle.includes('BPMN 运行时不可用'), '面板 bundle 不夹带 Host 工具代码')

const server = await startServer(bundle)
const base = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ executablePath: chromePath, headless: true })
const page = await browser.newPage({ viewport: { width: 900, height: 800 } })
const pageErrors = []
page.on('pageerror', error => pageErrors.push(String(error)))

try {
  await page.goto(base + '/harness.html', { waitUntil: 'load' })
  await page.waitForFunction(() => typeof window.__mountWorktreePanel === 'function')

  await check('面板渲染：模式 / 路径 / 分支 / HEAD / dirty / 可清理', async () => {
    await mountPanel(page, { payload: worktreePayload(), instanceId: 'i-1', instanceStatus: 'COMPLETED' })
    await page.locator('[data-wt-mode="worktree"]').waitFor({ state: 'visible', timeout: 5000 })
    const text = await page.locator('#mount').innerText()
    ok(text.includes('worktree 隔离'))
    ok(text.includes('/managed/worktrees/abcdefabcdef/i-1'))
    ok(text.includes('flow-instance/i-1'))
    ok(text.includes('aaaaaaaaaaaa'))
    ok(text.includes('工作树干净'))
    ok(text.includes('可清理'))
    eq(await page.locator('[data-action="worktree-remove"]').isDisabled(), false)
  })

  await check('ACTIVE：清理按钮真实 disabled，原因可见', async () => {
    await mountPanel(page, {
      payload: worktreePayload({ instanceStatus: 'ACTIVE', cleanable: false }),
      instanceId: 'i-1',
      instanceStatus: 'ACTIVE',
    })
    await page.locator('[data-wt-blocked="true"]').waitFor({ state: 'visible', timeout: 5000 })
    eq(await page.locator('[data-action="worktree-remove"]').isDisabled(), true)
    eq(await page.locator('[data-action="worktree-branch"]').isDisabled(), true)
    const title = await page.locator('[data-action="worktree-remove"]').getAttribute('title')
    match(title, /ACTIVE/)
    const blocked = await page.locator('[data-wt-blocked="true"]').innerText()
    ok(blocked.includes('禁止清理工作树'))
  })

  await check('危险操作：二次确认 → 请求带 expectedHead；409 进 notice 且保留服务端原因', async () => {
    const serverError = '实例 i-1 当前是 ACTIVE：禁止清理工作树'
    await mountPanel(page, {
      payload: worktreePayload(),
      instanceId: 'i-1',
      instanceStatus: 'COMPLETED',
      removeError: { status: 409, code: 'INSTANCE_WORKTREE_INSTANCE_ACTIVE', error: serverError },
    })
    await page.locator('[data-action="worktree-remove"]').waitFor({ state: 'visible', timeout: 5000 })
    ok(await page.locator('[data-wt-confirm="remove"]').count() === 0, '未确认前没有确认块')
    await page.locator('[data-action="worktree-remove"]').click()
    await page.locator('[data-wt-confirm="remove"]').waitFor({ state: 'visible', timeout: 5000 })
    await page.locator('[data-action="worktree-remove-confirm"]').click()
    await page.waitForFunction(() => document.getElementById('notice').dataset.kind === 'warn')
    const notice = await page.locator('#notice').innerText()
    ok(notice.includes('禁止清理工作树'), '保留服务端原因')
    ok(notice.includes('ACTIVE'))
    const calls = await page.evaluate(() => window.__calls)
    const removeCall = calls.find(call => call.kind === 'remove')
    ok(removeCall !== undefined)
    eq(removeCall.body.expectedHead, HEAD)
    eq(removeCall.body.removeBranch, true)
    eq(removeCall.body.force, undefined)
  })

  await check('全局清理：list + dryRun 预览，展示 orphan / planHash / 清单', async () => {
    await mountPanel(page, { payload: worktreePayload(), instanceId: '', list: pruneList(), preview: prunePreview() })
    await page.locator('[data-action="worktree-prune-open"]').click()
    await page.locator('[data-prune-open="true"]').waitFor({ state: 'visible', timeout: 5000 })
    await page.locator('[data-prune-hash]').waitFor({ state: 'visible', timeout: 5000 })
    const text = await page.locator('#mount').innerText()
    ok(text.includes('共 2 个实例工作树，其中孤儿 1 个'))
    ok(text.includes('孤儿'))
    ok(text.includes('将删除'))
    ok(text.includes(PLAN_HASH))
    const calls = await page.evaluate(() => window.__calls)
    eq(calls.some(call => call.kind === 'prune' && call.body.dryRun === true), true)
  })

  await check('PLAN_STALE：提示重新预览，旧 planHash 不再可执行', async () => {
    await mountPanel(page, {
      payload: worktreePayload(),
      instanceId: '',
      list: pruneList(),
      preview: prunePreview(),
      pruneError: { status: 409, code: 'INSTANCE_WORKTREE_PLAN_STALE', error: '工作区状态已变化，旧 planHash 失效，请重新预览' },
    })
    await page.locator('[data-action="worktree-prune-open"]').click()
    await page.locator('[data-action="worktree-prune-exec"]').waitFor({ state: 'visible', timeout: 5000 })
    await page.locator('[data-action="worktree-prune-exec"]').click()
    await page.waitForFunction(() => document.getElementById('notice').dataset.kind === 'warn')
    const notice = await page.locator('#notice').innerText()
    ok(notice.includes('旧 planHash 失效'))
    ok(notice.includes('重新预览'))
    eq(await page.locator('[data-action="worktree-prune-exec"]').count(), 0, '旧 planHash 已清除')
    await page.locator('[data-prune-stale="true"]').waitFor({ state: 'visible', timeout: 5000 })
    const calls = await page.evaluate(() => window.__calls)
    eq(calls.filter(call => call.kind === 'prune' && call.body.dryRun === false).length, 1, '不自动重试')
  })

  await check('暗色可用 + 窄窗口不横向溢出', async () => {
    await page.evaluate(() => { document.body.dataset.dsDarkTheme = '1' })
    await mountPanel(page, { payload: worktreePayload(), instanceId: 'i-1', instanceStatus: 'COMPLETED' })
    await page.locator('[data-wt-mode="worktree"]').waitFor({ state: 'visible', timeout: 5000 })
    const color = await page.locator('.fs-wt').evaluate(node => getComputedStyle(node).color)
    ok(/242\s*,\s*244\s*,\s*247|#f2f4f7/i.test(color), `暗色标签色应取 label-primary（实际 ${color}）`)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    ok(overflow <= 1, `窄视口不应横向溢出（多出 ${overflow}px）`)
    await page.setViewportSize({ width: 360, height: 800 })
    await page.waitForTimeout(120)
    const narrowOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    ok(narrowOverflow <= 1, `360px 视口不应横向溢出（多出 ${narrowOverflow}px）`)
    await page.setViewportSize({ width: 900, height: 800 })
    await page.evaluate(() => { delete document.body.dataset.dsDarkTheme })
  })

  await check('全程没有未捕获页面错误', () => {
    eq(pageErrors.length, 0, pageErrors.join('\n'))
  })
} finally {
  await page.close().catch(() => {})
  await browser.close().catch(() => {})
  await new Promise(resolveClose => server.close(() => resolveClose()))
}

console.log(`\n浏览器验收（工作区面板）：${checks} 组通过（${assertions} 条断言）`)
