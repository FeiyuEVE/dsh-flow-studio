#!/usr/bin/env node
/**
 * 0.13.3 步骤 3–4 真浏览器验收（playwright-core + 本机 Chrome）。
 *
 * 覆盖：
 *   1. 宿主 chunk 协议：`client.bpmn.js` 注册 → factory → mountEditor；
 *   2. palette 创建人工 / agent / HTTP 三类节点，程序化连线；
 *   3. 官方属性面板改业务字段（节点/提示词/skills/hooks/team/check/输出/HTTP/连线）；
 *   4. check 非法 JSON 显示字段错误且不静默清空；
 *   5. 画布聚焦下的 Ctrl+Z / Ctrl+Y；输入框内 Delete/Ctrl+Z 不触发图操作；
 *   6. 导出 XML → 服务端 `parseBpmn()` 断言业务字段；
 *   7. 重新导入 → 字段保持、dirty 清空、撤销栈清空；
 *   8. 水印存在且未被遮挡；暗色下画布文字/节点可读；窄窗口不横向溢出；
 *   9. 无额外 CSS/字体请求（官方样式与 woff2 已内联）；
 *  10. 实例只读视图（NavigatedViewer）、运行态 marker 不写 XML、destroy 清理。
 *
 * 运行（需要先 npm run build）：
 *   node test/client-bpmn.browser.test.mjs
 *   BPMN_TEST_BROWSER=/usr/bin/google-chrome node test/client-bpmn.browser.test.mjs
 *
 * 测试 profile / 截图输出：`.tmp/0.13.3/phase-b/`（项目内临时目录）。
 */

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright-core'

import { parseBpmn } from '../src/bpmn-parse.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(repoRoot, '.tmp', '0.13.3', 'phase-b')
const chromePath = process.env.BPMN_TEST_BROWSER || '/usr/bin/google-chrome'
mkdirSync(outDir, { recursive: true })

let checks = 0
let assertions = 0
const A = {
  ok(value, message) { assertions += 1; assert.ok(value, message) },
  equal(actual, expected, message) { assertions += 1; assert.equal(actual, expected, message) },
  notEqual(actual, expected, message) { assertions += 1; assert.notEqual(actual, expected, message) },
  deepEqual(actual, expected, message) { assertions += 1; assert.deepEqual(actual, expected, message) },
  match(value, pattern, message) { assertions += 1; assert.match(value, pattern, message) },
}

async function check(name, fn) {
  const result = await fn()
  checks += 1
  console.log(`  ✓ ${name}`)
  return result
}

const chunkSource = readFileSync(join(repoRoot, 'lib/client.bpmn.js'), 'utf8')

const HARNESS_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>bpmn chunk harness</title>
<style>
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
  --dsw-alias-interactive-bg-hover:#252932;
}
html,body{margin:0;padding:0;height:100%;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family)}
#app{height:100vh;display:flex;min-width:0}
#mount{flex:1;min-width:0;min-height:0}
</style>
</head>
<body>
<div id="app"><div id="mount"></div></div>
<script>
window.__ModuleLoader__ = {
  load(definition) {
    try {
      window.__chunk = definition.factory(function require(name) {
        throw new Error('chunk 不应 require 外部模块: ' + name)
      })
      window.__chunkError = null
    } catch (error) {
      window.__chunkError = String((error && error.stack) || error)
    }
  }
}
</script>
<script src="/lib/client.bpmn.js"></script>
<script>
window.__mountEditor = async function (options) {
  if (window.__chunkError) throw new Error('chunk factory 失败: ' + window.__chunkError)
  window.__editor = window.__chunk.mountEditor(document.getElementById('mount'), options || {})
  const result = await window.__editor.ready
  if (!result.ok) throw result.error
  window.__modeler = window.__editor.getModeler()
  return result
}
</script>
</body>
</html>`

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/lib/client.bpmn.js') {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' })
      res.end(chunkSource)
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

/* ── 页面操作辅助 ───────────────────────────────────────────────── */

async function selectById(page, id) {
  await page.evaluate(elementId => {
    const modeler = window.__modeler
    const element = modeler.get('elementRegistry').get(elementId)
    if (!element) throw new Error('element not found: ' + elementId)
    modeler.get('selection').select(element)
  }, id)
  await page.waitForTimeout(250)
}

async function openGroup(page, id) {
  const header = page.locator(`[data-group-id="group-${id}"] .bio-properties-panel-group-header`)
  await header.waitFor({ state: 'attached', timeout: 5000 })
  const className = (await header.getAttribute('class')) || ''
  if (!/(^|\s)open(\s|$)/.test(className)) {
    await header.click()
    await page.waitForTimeout(150)
  }
}

async function openListItem(page, id) {
  const entry = page.locator(`[data-entry-id="${id}"]`)
  await entry.waitFor({ state: 'attached', timeout: 5000 })
  const className = (await entry.getAttribute('class')) || ''
  if (!/(^|\s)open(\s|$)/.test(className)) {
    await entry.locator('.bio-properties-panel-collapsible-entry-header').click()
    await page.waitForTimeout(150)
  }
}

async function fillField(page, entryId, value) {
  const locator = page.locator(`[data-entry-id="${entryId}"] textarea, [data-entry-id="${entryId}"] input`).first()
  await locator.waitFor({ state: 'visible', timeout: 5000 })
  await locator.fill(value)
  // 属性面板默认 600ms 去抖；Tab 触发 blur 会立即提交，测试不用等 600ms。
  await page.keyboard.press('Tab')
  await page.waitForTimeout(180)
}

async function selectField(page, entryId, value) {
  const locator = page.locator(`[data-entry-id="${entryId}"] select`).first()
  await locator.waitFor({ state: 'visible', timeout: 5000 })
  await locator.selectOption(value)
  await page.waitForTimeout(220)
}

async function panelHeader(page) {
  return page.evaluate(() => {
    const node = document.querySelector('.bio-properties-panel-header')
    return node ? node.innerText.trim() : ''
  })
}

async function elementSummary(page, id) {
  return page.evaluate(elementId => {
    const modeler = window.__modeler
    const element = modeler.get('elementRegistry').get(elementId)
    if (!element) return null
    const businessObject = element.businessObject
    const values = businessObject.extensionElements
      ? businessObject.extensionElements.values || []
      : []
    const fsNode = values.find(value => value.$type === 'fs:Node')
    return {
      id: element.id,
      type: element.type,
      name: businessObject.name || '',
      nodeType: fsNode ? fsNode.nodeType || '' : '',
      provider: fsNode ? fsNode.provider || '' : '',
      adapter: fsNode ? fsNode.adapter || '' : '',
      model: fsNode ? fsNode.model || '' : '',
      agentPreset: fsNode ? fsNode.agentPreset || '' : '',
      prompt: fsNode ? fsNode.prompt || '' : '',
      roleCard: fsNode ? fsNode.roleCard || '' : '',
      skills: fsNode ? fsNode.skills || '' : '',
      hooks: fsNode ? fsNode.hooks || '' : '',
      check: fsNode && fsNode.check ? fsNode.check.json || '' : '',
    }
  }, id)
}

async function watermarkInfo(page) {
  return page.evaluate(() => {
    const link = document.querySelector('.bjs-powered-by')
    const canvas = document.querySelector('.fs-bpmn-editor-canvas')
    if (!link || !canvas) return null
    const linkBox = link.getBoundingClientRect()
    const canvasBox = canvas.getBoundingClientRect()
    const overlapWidth = Math.min(linkBox.right, canvasBox.right) - Math.max(linkBox.left, canvasBox.left)
    const overlapHeight = Math.min(linkBox.bottom, canvasBox.bottom) - Math.max(linkBox.top, canvasBox.top)
    const centerX = linkBox.left + linkBox.width / 2
    const centerY = linkBox.top + linkBox.height / 2
    const top = document.elementFromPoint(centerX, centerY)
    return {
      href: link.getAttribute('href'),
      title: link.getAttribute('title'),
      stylePosition: getComputedStyle(link).position,
      visible: !!(link.offsetWidth || link.offsetHeight),
      linkBox: { x: linkBox.x, y: linkBox.y, width: linkBox.width, height: linkBox.height },
      canvasBox: { x: canvasBox.x, y: canvasBox.y, width: canvasBox.width, height: canvasBox.height },
      overlap: Math.max(0, overlapWidth) * Math.max(0, overlapHeight),
      coveredBy: top ? (top.closest && top.closest('.bjs-powered-by') ? 'watermark' : top.tagName) : null,
    }
  })
}

function luminance(color) {
  const match = /rgba?\(([^)]+)\)/.exec(color)
  if (!match) return null
  const parts = match[1].split(',').map(value => Number(value.trim()))
  const [r, g, b] = parts
  const channel = value => {
    const normalized = value / 255
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

async function run() {
  const server = await startServer()
  const port = server.address().port
  const baseUrl = `http://127.0.0.1:${port}/`
  const browser = await chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] })
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } })
  const page = await context.newPage()
  const pageErrors = []
  const requests = []
  page.on('pageerror', error => pageErrors.push(String((error && error.stack) || error))); 
  page.on('request', request => requests.push(request.url()))

  try {
    const response = await page.goto(baseUrl, { waitUntil: 'load' })
    A.equal(response.status(), 200, 'harness 页面返回 200')

    await check('chunk 协议：注册、factory、mountEditor、内联样式', async () => {
      const boot = await page.evaluate(async () => {
        const result = await window.__mountEditor({})
        const chunk = window.__chunk
        return {
          result,
          version: chunk.version,
          cssBytes: chunk.BPMN_EDITOR_CSS.length,
          hasFont: chunk.BPMN_EDITOR_CSS.includes('data:font/woff2;base64,'),
          externalUrl: /url\(\s*['"]?(?:\.\.?\/|https?:)/.test(chunk.BPMN_EDITOR_CSS),
          styleTags: document.querySelectorAll('style[data-fs-bpmn-style]').length,
        }
      })
      A.equal(boot.result.mode, 'modeler', '默认挂载 Modeler')
      A.match(boot.version, /^0\.13\.3/, 'chunk 版本是 0.13.3 阶段')
      A.ok(boot.cssBytes > 100000, 'chunk 自带 >100KB 官方样式')
      A.ok(boot.hasFont, 'woff2 字体 base64 内联')
      A.equal(boot.externalUrl, false, '样式里没有外部 url()')
      A.equal(boot.styleTags, 1, '样式节点只注入一次')
    })

    await check('palette 只提供执行白名单内节点', async () => {
      const actions = await page.evaluate(() => [...document.querySelectorAll('.djs-palette [data-action]')]
        .map(entry => entry.getAttribute('data-action')))
      for (const expected of [
        'create.start-event', 'create.end-event', 'create.user-task',
        'create.agent-task', 'create.http-task', 'create.exclusive-gateway',
      ]) {
        A.ok(actions.includes(expected), `palette 有 ${expected}`)
      }
      for (const forbidden of [
        'create.parallel-gateway', 'create.inclusive-gateway', 'create.script-task',
        'create.sub-process', 'create.call-activity', 'create.task',
      ]) {
        A.ok(!actions.includes(forbidden), `palette 不提供 ${forbidden}`)
      }
    })

    const created = await check('palette 创建人工 / agent / HTTP / 结束节点并连线', async () => {
      const canvasBox = await page.locator('.djs-container').boundingBox()
      const startY = Math.round(canvasBox.y + canvasBox.height / 2)
      const plan = [
        ['create.user-task', 300],
        ['create.agent-task', 520],
        ['create.http-task', 740],
        ['create.end-event', 940],
      ]
      for (const [action, x] of plan) {
        await page.click(`.djs-palette [data-action="${action}"]`)
        await page.mouse.click(canvasBox.x + x, startY)
        await page.waitForTimeout(250)
      }
      const result = await page.evaluate(() => {
        const modeler = window.__modeler
        const modeling = modeler.get('modeling')
        const registry = modeler.get('elementRegistry')
        const all = registry.getAll()
        const human = all.find(element => element.type === 'bpmn:UserTask')
        const services = all.filter(element => element.type === 'bpmn:ServiceTask')
        const agent = services[0]
        const http = services[1]
        const endEvent = all.find(element => element.type === 'bpmn:EndEvent')
        const startEvent = all.find(element => element.type === 'bpmn:StartEvent')
        if (!human || !agent || !http || !endEvent || !startEvent) {
          throw new Error('palette 创建结果不完整')
        }
        modeling.updateProperties(human, { name: '人工审批' })
        modeling.updateProperties(agent, { name: 'Agent 节点' })
        modeling.updateProperties(http, { name: 'HTTP 节点' })
        modeling.updateProperties(endEvent, { name: '结束' })
        // 把 createDiagram() 自带的开始事件挪到链路左侧，避免 fit-viewport 后
        // 被左上角 palette 压住（纯测试布局，不影响业务断言）。
        modeling.moveElements([startEvent], {
          x: human.x - 70 - startEvent.x,
          y: human.y + human.height / 2 - startEvent.height / 2 - startEvent.y,
        })
        modeler.get('canvas').zoom('fit-viewport', 'auto')
        const flow1 = modeling.connect(startEvent, human)
        const flow2 = modeling.connect(human, agent)
        const flow3 = modeling.connect(agent, http)
        const flow4 = modeling.connect(http, endEvent)
        window.__ids = {
          start: startEvent.id,
          human: human.id,
          agent: agent.id,
          http: http.id,
          end: endEvent.id,
          flow1: flow1.id,
          flow2: flow2.id,
          flow3: flow3.id,
          flow4: flow4.id,
        }
        const fsOf = element => {
          const values = element.businessObject.extensionElements
            ? element.businessObject.extensionElements.values || []
            : []
          const node = values.find(value => value.$type === 'fs:Node')
          return node ? node.nodeType : null
        }
        return {
          ids: window.__ids,
          types: { human: human.type, agent: agent.type, http: http.type, end: endEvent.type },
          nodeTypes: { agent: fsOf(agent), http: fsOf(http) },
          flowCount: registry.filter(element => element.type === 'bpmn:SequenceFlow').length,
        }
      })
      A.equal(result.types.human, 'bpmn:UserTask', '人工节点是 userTask')
      A.equal(result.types.agent, 'bpmn:ServiceTask', 'agent 是 serviceTask')
      A.equal(result.types.http, 'bpmn:ServiceTask', 'HTTP 是 serviceTask')
      A.equal(result.nodeTypes.agent, 'agent', 'agent 创建后立即有 fs:node[nodeType=agent]')
      A.equal(result.nodeTypes.http, 'http', 'HTTP 创建后立即有 fs:node[nodeType=http]')
      A.equal(result.flowCount, 4, '四条连线已创建')
      await page.waitForTimeout(400)
      return result.ids
    })

    await check('连线：条件表达式（FEEL）与 fs:maxRounds', async () => {
      await selectById(page, created.flow2)
      await page.waitForSelector('[data-group-id="group-fs-flow"]', { timeout: 5000 })
      A.match(await panelHeader(page), /SEQUENCE FLOW/, '面板切到连线')
      await openGroup(page, 'fs-flow')
      await fillField(page, 'fs-flow-condition', 'approved = true')
      await fillField(page, 'fs-flow-max-rounds', '3')
      const summary = await page.evaluate(() => {
        const flow = window.__modeler.get('elementRegistry').get(window.__ids.flow2)
        const businessObject = flow.businessObject
        const condition = businessObject.conditionExpression
        const values = businessObject.extensionElements
          ? businessObject.extensionElements.values || []
          : []
        const maxRounds = values.find(value => value.$type === 'fs:MaxRounds')
        return {
          body: condition ? condition.body : '',
          language: condition ? condition.language : '',
          maxRounds: maxRounds ? maxRounds.value : null,
        }
      })
      A.equal(summary.body, 'approved = true', 'conditionExpression 正文写回')
      A.equal(summary.language, 'feel', '条件语言是 feel')
      A.equal(summary.maxRounds, 3, 'fs:maxRounds 写回连线扩展')
    })

    await check('人工节点提示词 + 节点类型字段存在', async () => {
      await selectById(page, created.human)
      await page.waitForSelector('[data-group-id="group-fs-node"]', { timeout: 5000 })
      A.match(await panelHeader(page), /USER TASK/, '面板切到人工任务')
      await openGroup(page, 'fs-node')
      const nodeType = await page.locator('[data-entry-id="fs-node-type"] select').inputValue()
      A.equal(nodeType, 'human', '节点类型字段显示 human')
      await openGroup(page, 'fs-prompt')
      await fillField(page, 'fs-node-prompt', '人工审批：确认发布窗口')
      const summary = await elementSummary(page, created.human)
      A.equal(summary.type, 'bpmn:UserTask', '人工节点保持 userTask')
      A.equal(summary.prompt, '人工审批：确认发布窗口', 'userTask 的 prompt 存在 fs:node')
      A.equal(summary.nodeType, '', 'userTask 不写 nodeType')
    })

    await check('agent 节点：provider/adapter/model/preset/prompt/skills/hooks', async () => {
      await selectById(page, created.agent)
      await page.waitForSelector('[data-group-id="group-fs-node"]', { timeout: 5000 })
      await openGroup(page, 'fs-node')
      await fillField(page, 'fs-node-provider', 'deepseek')
      await selectField(page, 'fs-node-adapter', 'dsh')
      await fillField(page, 'fs-node-model', 'deepseek-chat')
      await fillField(page, 'fs-node-agent-preset', 'coder')
      await openGroup(page, 'fs-prompt')
      await fillField(page, 'fs-node-prompt', '实现登录接口并补测试')
      await fillField(page, 'fs-node-role-card', '你是后端工程师，负责可维护的实现')
      await openGroup(page, 'fs-advanced')
      await fillField(page, 'fs-node-skills', 'code-review, testing')
      await fillField(page, 'fs-node-hooks', 'turn.stop')
      const summary = await elementSummary(page, created.agent)
      A.equal(summary.nodeType, 'agent', 'agent nodeType 保持')
      A.equal(summary.provider, 'deepseek', 'provider 写回')
      A.equal(summary.adapter, 'dsh', 'adapter 写回')
      A.equal(summary.model, 'deepseek-chat', 'model 写回')
      A.equal(summary.agentPreset, 'coder', 'agentPreset 写回')
      A.equal(summary.prompt, '实现登录接口并补测试', 'prompt 写回')
      A.equal(summary.roleCard, '你是后端工程师，负责可维护的实现', 'roleCard 写回')
      A.equal(summary.skills, 'code-review,testing', 'skills 按列表字符串序列化')
      A.equal(summary.hooks, 'turn.stop', 'hooks 按列表字符串序列化')
    })

    await check('节点类型下拉：agent ↔ http，HTTP 配置组随类型出现/消失', async () => {
      await openGroup(page, 'fs-node')
      await selectField(page, 'fs-node-type', 'http')
      await page.waitForSelector('[data-group-id="group-fs-http"]', { timeout: 5000 })
      A.equal((await elementSummary(page, created.agent)).nodeType, 'http', '切换后 nodeType=http')
      await openGroup(page, 'fs-http')
      await selectField(page, 'fs-http-method', 'POST')
      await fillField(page, 'fs-http-url', 'https://example.com/hook')
      await fillField(page, 'fs-http-headers', '{"content-type":"application/json"}')
      await fillField(page, 'fs-http-body', '{"event":"approve"}')
      await fillField(page, 'fs-http-timeout', '2500')
      await page.waitForTimeout(600)
      await selectField(page, 'fs-node-type', 'agent')
      await page.waitForTimeout(300)
      A.equal((await elementSummary(page, created.agent)).nodeType, 'agent', '切回 nodeType=agent')
      const hasHttpGroup = await page.locator('[data-group-id="group-fs-http"]').count()
      A.equal(hasHttpGroup, 0, 'agent 不显示 HTTP 配置组')
    })

    await check('team：fs:Team + fs:Member[] 列表增删与字段', async () => {
      await openGroup(page, 'fs-team')
      await selectField(page, 'fs-team-mode', 'fanout')
      await openGroup(page, 'fs-team-members')
      await page.locator('[data-group-id="group-fs-team-members"] .bio-properties-panel-add-entry').click()
      await page.waitForTimeout(300)
      await openGroup(page, 'fs-team-members')
      await openListItem(page, 'fs-team-member-0')
      await fillField(page, 'fs-team-member-0-id', 'reviewer')
      await fillField(page, 'fs-team-member-0-role', '审查者')
      await fillField(page, 'fs-team-member-0-skills', 'security, perf')
      await fillField(page, 'fs-team-member-0-prompt', '审查鉴权与性能')
      const team = await page.evaluate(() => {
        const element = window.__modeler.get('elementRegistry').get(window.__ids.agent)
        const values = element.businessObject.extensionElements.values
        const fsNode = values.find(value => value.$type === 'fs:Node')
        const teamNode = fsNode.team
        const members = teamNode.member || []
        return {
          mode: teamNode.mode,
          member: {
            id: members[0] && members[0].id,
            role: members[0] && members[0].role,
            skills: members[0] && members[0].skills,
            prompt: members[0] && members[0].prompt,
          },
        }
      })
      A.equal(team.mode, 'fanout', 'team mode 写回')
      A.equal(team.member.id, 'reviewer', 'member id 写回')
      A.equal(team.member.role, '审查者', 'member role 写回')
      A.equal(team.member.skills, 'security,perf', 'member skills 列表字符串')
      A.equal(team.member.prompt, '审查鉴权与性能', 'member prompt 写回')
    })

    await check('check：非法 JSON 显示字段错误且不静默清空，改回合法后消除', async () => {
      await openGroup(page, 'fs-check')
      const checkEntry = page.locator('[data-entry-id="fs-check"]')
      await fillField(page, 'fs-check', '{"min":')
      await checkEntry.locator('.bio-properties-panel-error').first().waitFor({ state: 'visible', timeout: 5000 })
      const errorText = await checkEntry.locator('.bio-properties-panel-error').first().innerText()
      A.match(errorText, /JSON 语法错误/, '字段下方显示 JSON 语法错误')
      A.match(await checkEntry.getAttribute('class'), /has-error/, 'entry 标记为错误态')
      const raw = await page.evaluate(() => {
        const element = window.__modeler.get('elementRegistry').get(window.__ids.agent)
        const values = element.businessObject.extensionElements.values
        const fsNode = values.find(value => value.$type === 'fs:Node')
        return fsNode.check ? fsNode.check.json : ''
      })
      A.equal(raw, '{"min":', '非法值原样保留在 fs:check 正文里')
      await fillField(page, 'fs-check', '{"minPass":true}')
      await page.waitForTimeout(300)
      A.equal(await checkEntry.locator('.bio-properties-panel-error').count(), 0, '合法 JSON 不再显示错误')
    })

    await check('输出声明：fs:Output[] 列表添加与 JSON 声明', async () => {
      await openGroup(page, 'fs-outputs')
      await page.locator('[data-group-id="group-fs-outputs"] .bio-properties-panel-add-entry').click()
      await page.waitForTimeout(300)
      await openGroup(page, 'fs-outputs')
      await openListItem(page, 'fs-output-0')
      await fillField(page, 'fs-output-0-value', '{"name":"report","kind":"markdown","required":true}')
      const outputs = await page.evaluate(() => {
        const element = window.__modeler.get('elementRegistry').get(window.__ids.agent)
        const values = element.businessObject.extensionElements.values
        const fsNode = values.find(value => value.$type === 'fs:Node')
        return (fsNode.output || []).map(output => ({
          name: output.name,
          kind: output.kind,
          required: output.required,
        }))
      })
      A.deepEqual(outputs, [{ name: 'report', kind: 'markdown', required: true }], 'fs:output 属性写回')
    })

    await check('HTTP 节点：fs:Http 配置写回', async () => {
      await selectById(page, created.http)
      await page.waitForSelector('[data-group-id="group-fs-http"]', { timeout: 5000 })
      await openGroup(page, 'fs-http')
      await selectField(page, 'fs-http-method', 'POST')
      await fillField(page, 'fs-http-url', 'https://example.com/hook')
      await fillField(page, 'fs-http-headers', '{"content-type":"application/json"}')
      await fillField(page, 'fs-http-body', '{"event":"approve"}')
      await fillField(page, 'fs-http-timeout', '2500')
      const summary = await page.evaluate(() => {
        const element = window.__modeler.get('elementRegistry').get(window.__ids.http)
        const values = element.businessObject.extensionElements.values
        const fsNode = values.find(value => value.$type === 'fs:Node')
        return {
          nodeType: fsNode.nodeType,
          method: fsNode.http && fsNode.http.method,
          url: fsNode.http && fsNode.http.url,
          headers: fsNode.http && fsNode.http.headers,
          timeoutMs: fsNode.http && fsNode.http.timeoutMs,
        }
      })
      A.equal(summary.nodeType, 'http', 'HTTP 节点 nodeType=http')
      A.equal(summary.method, 'POST', 'HTTP method 写回')
      A.equal(summary.url, 'https://example.com/hook', 'HTTP url 写回')
      A.equal(summary.headers, '{"content-type":"application/json"}', 'headers 原样保存 JSON 字符串')
      A.equal(summary.timeoutMs, 2500, 'timeoutMs 以整数写回')
    })

    await check('画布快捷键：Ctrl+Z / Ctrl+Y；输入框内不触发图操作', async () => {
      await page.waitForTimeout(700)
      const before = await page.evaluate(() => window.__editor.saveXML())
      const stackBefore = await page.evaluate(() => window.__modeler.get('commandStack')._stack.length)
      // 点击画布空白处：焦点落到 canvas SVG（不选中元素），快捷键才归画布。
      await page.mouse.click(120, 760)
      await page.waitForTimeout(150)
      const activeTag = await page.evaluate(() => `${document.activeElement.tagName}.${document.activeElement.getAttribute('class') || ''}`)
      A.match(activeTag, /^svg|^SVG/, '焦点在画布 SVG 上')
      let afterUndo = before
      let undoCount = 0
      // 属性面板失焦可能留下“同值重写”的命令；最多连按 3 次仍必须有一次真实撤销。
      while (undoCount < 3 && afterUndo === before) {
        await page.keyboard.press('Control+z')
        await page.waitForTimeout(250)
        afterUndo = await page.evaluate(() => window.__editor.saveXML())
        undoCount += 1
      }
      A.notEqual(afterUndo, before, 'Ctrl+Z 撤销图编辑')
      for (let index = 0; index < undoCount; index += 1) {
        await page.keyboard.press('Control+y')
        await page.waitForTimeout(200)
      }
      const afterRedo = await page.evaluate(() => window.__editor.saveXML())
      A.equal(afterRedo, before, 'Ctrl+Y 恢复')

      // 输入框里 Delete / Ctrl+Z 只影响文本，不删除图元、不写撤销栈。
      await selectById(page, created.agent)
      await openGroup(page, 'fs-prompt')
      await page.locator('[data-entry-id="fs-node-prompt"] textarea').focus()
      const elementCount = await page.evaluate(() => window.__modeler.get('elementRegistry').getAll().length)
      const stackInInput = await page.evaluate(() => window.__modeler.get('commandStack')._stack.length)
      await page.keyboard.press('Delete')
      await page.keyboard.press('Control+z')
      await page.waitForTimeout(200)
      const elementCountAfter = await page.evaluate(() => window.__modeler.get('elementRegistry').getAll().length)
      const stackAfterInput = await page.evaluate(() => window.__modeler.get('commandStack')._stack.length)
      A.equal(elementCountAfter, elementCount, '输入框内 Delete 不删除图元')
      A.equal(stackAfterInput, stackInInput, '输入框内 Ctrl+Z 不进入图撤销栈')
      A.ok(stackBefore > 0, '此前的编辑已进入撤销栈')
    })

    let exportedXml = ''
    await check('导出 XML：服务端 parseBpmn 校验业务字段', async () => {
      await page.waitForTimeout(700)
      exportedXml = await page.evaluate(() => window.__editor.saveXML())
      writeFileSync(join(outDir, 'exported.bpmn'), exportedXml)
      A.match(exportedXml, /<fs:node/, 'XML 含 fs:node')
      const parsed = await parseBpmn(exportedXml)
      A.equal(parsed.ok, true, `parseBpmn 通过（errors=${JSON.stringify(parsed.errors)}）`)
      A.deepEqual(parsed.errors, [], '无解析错误')
      const byId = new Map(parsed.definition.elements.map(element => [element.id, element]))
      const human = byId.get(created.human)
      const agent = byId.get(created.agent)
      const http = byId.get(created.http)
      A.equal(human.kind, 'human', '人工节点 kind=human')
      A.equal(human.node.prompt, '人工审批：确认发布窗口', '人工 prompt 保持')
      A.equal(agent.kind, 'agent', 'agent kind=agent')
      A.equal(agent.node.provider, 'deepseek', 'provider 保持')
      A.equal(agent.node.adapter, 'dsh', 'adapter 保持')
      A.equal(agent.node.model, 'deepseek-chat', 'model 保持')
      A.equal(agent.node.agentPreset, 'coder', 'agentPreset 保持')
      A.deepEqual(agent.node.skills, ['code-review', 'testing'], 'skills 解析成数组')
      A.deepEqual(agent.node.hooks, ['turn.stop'], 'hooks 解析成数组')
      A.equal(agent.node.team.mode, 'fanout', 'team mode 保持')
      A.equal(agent.node.team.members[0].id, 'reviewer', 'member id 保持')
      A.deepEqual(agent.node.team.members[0].skills, ['security', 'perf'], 'member skills 解析成数组')
      A.deepEqual(agent.node.check, { minPass: true }, 'check JSON 保持')
      A.deepEqual(agent.node.outputs, [{ name: 'report', kind: 'markdown', required: true }], 'fs:output 声明保持')
      A.equal(http.kind, 'http', 'HTTP kind=http')
      A.equal(http.node.http.method, 'POST', 'HTTP method 保持')
      A.equal(http.node.http.url, 'https://example.com/hook', 'HTTP url 保持')
      A.deepEqual(http.node.http.headers, { 'content-type': 'application/json' }, 'HTTP headers 解析成对象')
      A.equal(http.node.http.timeoutMs, 2500, 'HTTP timeoutMs 保持')
      const flow = parsed.definition.flows.find(item => item.id === created.flow2)
      A.deepEqual(flow.condition, { expression: 'approved = true', language: 'feel' }, '连线条件保持 FEEL')
      const maxRounds = flow.extensions.find(item => item.name === 'maxRounds')
      A.equal(maxRounds && maxRounds.value, 3, '连线 maxRounds 保持')
    })

    await check('重新导入：字段保持、dirty/撤销栈清空', async () => {
      const reimport = await page.evaluate(async xml => {
        await window.__editor.importXML(xml)
        return {
          dirty: window.__editor.isDirty(),
          canUndo: window.__modeler.get('commandStack').canUndo(),
          xml: await window.__editor.saveXML(),
          summary: ['human', 'agent', 'http'].map(key => {
            const id = window.__ids[key]
            const element = window.__modeler.get('elementRegistry').get(id)
            const values = element.businessObject.extensionElements
              ? element.businessObject.extensionElements.values
              : []
            const fsNode = values.find(value => value.$type === 'fs:Node')
            return {
              key,
              type: element.type,
              nodeType: fsNode ? fsNode.nodeType : '',
              prompt: fsNode ? fsNode.prompt : '',
              provider: fsNode ? fsNode.provider : '',
              check: fsNode && fsNode.check ? fsNode.check.json : '',
            }
          }),
        }
      }, exportedXml)
      A.equal(reimport.dirty, false, '导入后 dirty=false')
      A.equal(reimport.canUndo, false, '导入后撤销栈为空')
      A.equal(reimport.summary[0].prompt, '人工审批：确认发布窗口', '人工 prompt 保持')
      A.equal(reimport.summary[1].provider, 'deepseek', 'agent provider 保持')
      A.equal(reimport.summary[1].check, '{"minPass":true}', 'check 保持')
      A.equal(reimport.summary[2].nodeType, 'http', 'HTTP nodeType 保持')
      const parsed = await parseBpmn(reimport.xml)
      A.equal(parsed.ok, true, '再次导出仍可被服务端解析')
      const agent = parsed.definition.elements.find(element => element.id === created.agent)
      A.deepEqual(agent.node.outputs, [{ name: 'report', kind: 'markdown', required: true }], 'outputs 往返保持')
      A.equal(agent.node.team.members[0].id, 'reviewer', 'team 往返保持')
    })

    await check('水印：存在、可见且未被画布遮挡', async () => {
      const info = await watermarkInfo(page)
      A.ok(info, '找到 .bjs-powered-by')
      A.match(info.href, /bpmn\.io/, '水印链到 bpmn.io')
      A.match(info.title, /Powered by bpmn\.io/, '水印 title 保持官方文案')
      A.equal(info.stylePosition, 'absolute', '水印仍是官方绝对定位')
      A.ok(info.visible, '水印可见')
      A.ok(info.overlap > 0, '水印与画布可见区域相交')
      A.equal(info.coveredBy, 'watermark', '水印中心未被其它元素遮挡')
    })

    await check('暗色主题：SVG 文字/节点可读，切换不改 XML/撤销栈', async () => {
      const before = await page.evaluate(async () => ({
        xml: await window.__editor.saveXML(),
        stack: window.__modeler.get('commandStack')._stack.length,
        canUndo: window.__modeler.get('commandStack').canUndo(),
      }))
      await page.evaluate(() => document.body.setAttribute('data-ds-dark-theme', ''))
      await page.waitForTimeout(350)
      const styles = await page.evaluate(() => {
        const text = document.querySelector('.bio-theme-parent .djs-visual text')
        const shape = document.querySelector('.bio-theme-parent .djs-visual > rect, .bio-theme-parent .djs-visual > polygon, .bio-theme-parent .djs-visual > circle')
        const canvas = document.querySelector('.djs-container')
        return {
          textFill: text ? getComputedStyle(text).fill : '',
          shapeFill: shape ? getComputedStyle(shape).fill : '',
          shapeStroke: shape ? getComputedStyle(shape).stroke : '',
          canvasBg: canvas ? getComputedStyle(canvas).backgroundColor : '',
        }
      })
      const textLum = luminance(styles.textFill)
      const shapeLum = luminance(styles.shapeFill)
      A.ok(textLum !== null && shapeLum !== null, `取到 SVG 颜色（text=${styles.textFill} shape=${styles.shapeFill}）`)
      A.ok(Math.abs(textLum - shapeLum) > 0.25, `暗色下文字与节点底色亮度差足够（${textLum?.toFixed(2)} vs ${shapeLum?.toFixed(2)}）`)
      A.ok(textLum > shapeLum, '暗色节点浅色文字、深色底')
      const after = await page.evaluate(async () => ({
        xml: await window.__editor.saveXML(),
        stack: window.__modeler.get('commandStack')._stack.length,
        canUndo: window.__modeler.get('commandStack').canUndo(),
      }))
      A.equal(after.xml, before.xml, '切换主题不改 BPMN XML')
      A.equal(after.stack, before.stack, '切换主题不污染撤销栈')
      A.equal(after.canUndo, before.canUndo, '切换主题不改 canUndo')
      await page.screenshot({ path: join(outDir, 'dark.png'), fullPage: false })
      await page.evaluate(() => document.body.removeAttribute('data-ds-dark-theme'))
      await page.waitForTimeout(250)
      await page.screenshot({ path: join(outDir, 'light.png'), fullPage: false })
    })

    await check('窄窗口：不横向溢出，水印仍可见', async () => {
      await page.setViewportSize({ width: 480, height: 820 })
      await page.waitForTimeout(400)
      const layout = await page.evaluate(() => ({
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        editorScrollWidth: document.querySelector('.fs-bpmn-editor')?.scrollWidth || 0,
        editorClientWidth: document.querySelector('.fs-bpmn-editor')?.clientWidth || 0,
      }))
      A.ok(layout.scrollWidth <= layout.innerWidth + 2, `document 不横向溢出（${layout.scrollWidth} ≤ ${layout.innerWidth}）`)
      A.ok(layout.bodyScrollWidth <= layout.innerWidth + 2, `body 不横向溢出（${layout.bodyScrollWidth}）`)
      A.ok(layout.editorScrollWidth <= layout.editorClientWidth + 2, '编辑器内部不横向溢出')
      const info = await watermarkInfo(page)
      A.ok(info && info.overlap > 0, '窄窗口水印仍与画布相交')
      A.equal(info.coveredBy, 'watermark', '窄窗口水印中心可见')
      await page.screenshot({ path: join(outDir, 'narrow.png'), fullPage: false })
      await page.setViewportSize({ width: 1280, height: 860 })
      await page.waitForTimeout(300)
    })

    await check('样式/字体零额外请求', async () => {
      const external = requests.filter(url => /\.(css|woff2?|ttf|eot)(\?|#|$)/i.test(url))
      A.deepEqual(external, [], `没有额外 CSS/字体请求（实际请求 ${external.length} 个）`)
      const chunkRequests = requests.filter(url => /\/lib\/client\.bpmn\.js$/.test(new URL(url).pathname))
      A.equal(chunkRequests.length, 1, 'chunk 只请求一次')
      const style = await page.evaluate(() => {
        const node = document.querySelector('style[data-fs-bpmn-style]')
        return node ? { bytes: node.textContent.length, hasFont: node.textContent.includes('data:font/woff2;base64,') } : null
      })
      A.ok(style && style.bytes > 100000, '样式 <style> 已注入')
      A.ok(style && style.hasFont, '样式内包含内联 woff2')
      A.equal(/url\(\s*['"]?(?:\.\.?\/|https?:)/.test(chunkSource), false, 'chunk 产物无外部 url()')
    })

    await check('context pad / replace 菜单只留白名单入口', async () => {
      const contextPad = await page.evaluate(() => {
        const modeler = window.__modeler
        const shape = modeler.get('elementRegistry').get(window.__ids.agent)
        modeler.get('selection').select(shape)
        modeler.get('contextPad').open(shape, true)
        return [...document.querySelectorAll('.djs-context-pad [data-action]')].map(entry => entry.getAttribute('data-action'))
      })
      A.ok(contextPad.includes('append.user-task'), 'context pad 可追加人工节点')
      A.ok(contextPad.includes('append.agent-task'), 'context pad 可追加 agent')
      A.ok(contextPad.includes('append.http-task'), 'context pad 可追加 HTTP')
      A.ok(!contextPad.includes('append.append-task'), 'context pad 不提供裸 task')
      A.ok(!contextPad.includes('append.intermediate-event'), 'context pad 不提供中间事件')
      A.ok(!contextPad.includes('append.compensation-activity'), 'context pad 不提供补偿活动')

      const replaceEntry = page.locator('.djs-context-pad [data-action="replace"]')
      await replaceEntry.click()
      await page.waitForSelector('.djs-popup', { timeout: 5000 })
      const replaceIds = await page.evaluate(() => [...document.querySelectorAll('.djs-popup [data-id]')]
        .map(entry => entry.getAttribute('data-id')))
      A.ok(replaceIds.length > 0, 'replace 菜单有允许项')
      A.ok(replaceIds.some(id => id.includes('user-task')), 'agent 的 replace 菜单保留 userTask')
      for (const forbidden of ['script-task', 'call-activity', 'subprocess', 'parallel-gateway', 'inclusive-gateway']) {
        A.ok(!replaceIds.some(id => id.includes(forbidden)), `replace 菜单不提供 ${forbidden}`)
      }
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)

      // 人工节点上必须能换成 serviceTask（agent/HTTP 的基础类型）。
      const humanReplaceIds = await page.evaluate(() => {
        const modeler = window.__modeler
        const shape = modeler.get('elementRegistry').get(window.__ids.human)
        modeler.get('selection').select(shape)
        modeler.get('contextPad').open(shape, true)
        return [...document.querySelectorAll('.djs-context-pad [data-action]')].map(entry => entry.getAttribute('data-action'))
      })
      A.ok(humanReplaceIds.includes('append.agent-task'), '人工节点 context pad 可追加 agent')
      await page.locator('.djs-context-pad [data-action="replace"]').click()
      await page.waitForSelector('.djs-popup', { timeout: 5000 })
      const humanReplace = await page.evaluate(() => [...document.querySelectorAll('.djs-popup [data-id]')]
        .map(entry => entry.getAttribute('data-id')))
      A.ok(humanReplace.some(id => id.includes('service-task')), 'human 的 replace 菜单保留 serviceTask')
      A.ok(!humanReplace.some(id => id.includes('parallel-gateway') || id.includes('inclusive-gateway')), 'replace 不提供并行/包容网关')
      await page.keyboard.press('Escape')
      await page.waitForTimeout(200)
    })

    await check('规则层拒绝白名单外图元（脚本任务 / 并行网关 / 子流程）', async () => {
      const result = await page.evaluate(() => {
        const modeler = window.__editor.getModeler()
        const elementFactory = modeler.get('elementFactory')
        const rules = modeler.get('rules')
        const root = modeler.get('canvas').getRootElement()
        const check = type => rules.allowed('shape.create', {
          shape: elementFactory.createShape({ type }),
          target: root,
          position: { x: 120, y: 700 },
        })
        return {
          scriptTask: check('bpmn:ScriptTask'),
          parallelGateway: check('bpmn:ParallelGateway'),
          subProcess: check('bpmn:SubProcess'),
          bareTask: check('bpmn:Task'),
          userTask: check('bpmn:UserTask'),
          serviceTask: check('bpmn:ServiceTask'),
          exclusiveGateway: check('bpmn:ExclusiveGateway'),
        }
      })
      A.equal(result.scriptTask, false, 'scriptTask 被规则拒绝')
      A.equal(result.parallelGateway, false, 'parallelGateway 被规则拒绝')
      A.equal(result.subProcess, false, 'subProcess 被规则拒绝')
      A.equal(result.bareTask, false, '裸 task 被规则拒绝')
      A.equal(result.userTask, true, 'userTask 允许')
      A.equal(result.serviceTask, true, 'serviceTask 允许')
      A.equal(result.exclusiveGateway, true, 'exclusiveGateway 允许')
    })

    await check('运行态 marker：改表现层，不写 XML、不污染撤销栈', async () => {
      await page.waitForTimeout(500)
      const before = await page.evaluate(async () => ({
        xml: await window.__editor.saveXML(),
        stack: window.__modeler.get('commandStack')._stack.length,
      }))
      await page.evaluate(ids => {
        window.__editor.setRuntimeState([
          { elementId: ids.agent, state: 'active' },
          { elementId: ids.human, state: 'waiting' },
          { elementId: ids.http, state: 'failed' },
        ])
      }, created)
      await page.waitForTimeout(200)
      const marked = await page.evaluate(async ids => {
        const group = id => {
          const gfx = window.__modeler.get('elementRegistry').getGraphics(id)
          return gfx ? gfx.getAttribute('class') : ''
        }
        return {
          agent: group(ids.agent),
          human: group(ids.human),
          http: group(ids.http),
          xml: await window.__editor.saveXML(),
          stack: window.__modeler.get('commandStack')._stack.length,
          dirty: window.__editor.isDirty(),
        }
      }, created)
      A.match(marked.agent, /fs-runtime-active/, 'agent 有 active marker')
      A.match(marked.human, /fs-runtime-waiting/, 'human 有 waiting marker')
      A.match(marked.http, /fs-runtime-failed/, 'http 有 failed marker')
      A.equal(marked.xml, before.xml, 'marker 不写回 XML')
      A.equal(marked.stack, before.stack, 'marker 不产生命令')
      A.equal(marked.dirty, false, 'marker 不制造 dirty')
      await page.evaluate(() => window.__editor.setRuntimeState([]))
      await page.waitForTimeout(150)
      const cleared = await page.evaluate(() => {
        const gfx = window.__modeler.get('elementRegistry').getGraphics(window.__ids.agent)
        return gfx.getAttribute('class')
      })
      A.ok(!/fs-runtime-active/.test(cleared), '清空运行态后 marker 移除')
    })

    await check('实例只读视图：NavigatedViewer、不可编辑、字段保持', async () => {
      const snapshot = await page.evaluate(() => window.__editor.saveXML())
      const viewer = await page.evaluate(async () => {
        const result = await window.__editor.setViewerMode(true)
        const modeler = window.__editor.getModeler()
        return {
          result,
          mode: window.__editor.getMode(),
          modeling: modeler.get('modeling', false),
          palette: document.querySelectorAll('.djs-palette').length,
          panelHidden: document.querySelector('.fs-bpmn-editor-properties').hidden,
          panelChildren: document.querySelector('.fs-bpmn-editor-properties').childElementCount,
          watermark: !!document.querySelector('.bjs-powered-by'),
          xml: await window.__editor.saveXML(),
          shapes: modeler.get('elementRegistry').getAll().filter(element => element.type !== 'label' && element.type !== 'bpmn:Process' && element.type !== 'bpmn:SequenceFlow').length,
          connections: modeler.get('elementRegistry').getAll().filter(element => element.type === 'bpmn:SequenceFlow').length,
        }
      })
      A.equal(viewer.result.mode, 'viewer', 'setViewerMode(true) 返回 viewer')
      A.equal(viewer.mode, 'viewer', '编辑器处于 viewer 模式')
      A.equal(viewer.modeling, null, 'NavigatedViewer 没有 modeling 服务')
      A.equal(viewer.palette, 0, '只读视图无 palette')
      A.equal(viewer.panelHidden, true, '只读视图隐藏属性面板')
      A.equal(viewer.panelChildren, 0, '只读视图属性面板无残留 DOM')
      A.equal(viewer.watermark, true, '只读视图仍保留水印')
      A.equal(viewer.shapes, 5, '只读视图仍渲染全部节点')
      A.equal(viewer.connections, 4, '只读视图仍渲染全部连线')
      A.equal(viewer.xml, snapshot, '只读视图 saveXML 返回当前快照')

      const restored = await page.evaluate(async () => {
        const result = await window.__editor.setViewerMode(false)
        const modeler = window.__editor.getModeler()
        const element = modeler.get('elementRegistry').get(window.__ids.agent)
        const values = element.businessObject.extensionElements.values
        const fsNode = values.find(value => value.$type === 'fs:Node')
        return {
          result,
          modeling: !!modeler.get('modeling', false),
          provider: fsNode.provider,
          panelVisible: !document.querySelector('.fs-bpmn-editor-properties').hidden,
        }
      })
      A.equal(restored.result.mode, 'modeler', '切回 modeler')
      A.equal(restored.modeling, true, 'modeler 有 modeling 服务')
      A.equal(restored.provider, 'deepseek', '切回后业务字段保持')
      A.equal(restored.panelVisible, true, '属性面板恢复')
    })

    await check('destroy：释放 DOM、样式与实例', async () => {
      const result = await page.evaluate(() => {
        window.__editor.destroy()
        return {
          destroyed: window.__editor.isDestroyed(),
          editor: document.querySelectorAll('.fs-bpmn-editor').length,
          style: document.querySelectorAll('style[data-fs-bpmn-style]').length,
          mountChildren: document.getElementById('mount').childElementCount,
        }
      })
      A.equal(result.destroyed, true, 'isDestroyed()=true')
      A.equal(result.editor, 0, '编辑器 DOM 已移除')
      A.equal(result.style, 0, '样式节点已移除')
      A.equal(result.mountChildren, 0, '挂载点已清空')
    })

    await check('全程没有未捕获页面错误', async () => {
      A.deepEqual(pageErrors, [], `页面错误：${pageErrors.join(' | ')}`)
    })

    writeFileSync(join(outDir, 'chunk-size.json'), `${JSON.stringify({
      'client.js': readFileSync(join(repoRoot, 'lib/client.js')).length,
      'client.bpmn.js': readFileSync(join(repoRoot, 'lib/client.bpmn.js')).length,
      browser: chromePath,
    }, null, 2)}\n`)
    console.log(`\n浏览器验收：${checks} 组通过（${assertions} 条断言）`)
    console.log(`截图与结果：${outDir}`)
  } finally {
    await browser.close()
    await new Promise(resolveServer => server.close(resolveServer))
  }
}

run().catch(error => {
  console.error('\n✗ 浏览器验收失败：')
  console.error(error && error.stack ? error.stack : error)
  process.exit(1)
})
