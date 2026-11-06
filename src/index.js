/**
 * Host 半边：流程模板的读写接口。
 *
 * 浏览器端（client bundle）通过同源 fetch 调用 `/api/flow-studio/*`；
 * 面板本身不做任何持久化，所有流程都落在 $DSH_HOME 下，换浏览器/换设备都还在。
 *
 * 路由是 `prefix` 注册的一条：webserver 对插件路由不做自动鉴权
 * （内置 `/api` 的 connection.admit 只挂在通用 `/api` 前缀上，最长前缀会把请求先接走），
 * 所以这里自己挡跨站请求：带了 Origin 且与 Host 不一致就 403。
 *
 * @module @feiyueve/dsh-flow-studio
 */

import { validateFlow } from './model.js'
import {
  checkId, deleteFlow, flowsDir, listFlows, newFlowId, readFlow, saveFlow,
} from './store.js'

/** 硬依赖：没有 webServer 就没有面板的数据通道。 */
export const inject = ['webServer']

export const name = 'flow-studio'

/** 单个请求体的上限，2 MiB 足够装下几十个节点的流程。 */
const MAX_BODY_BYTES = 2 * 1024 * 1024

/** 面板路由前缀。 */
const BASE = '/api/flow-studio'

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 读请求体（带大小上限）。 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') return resolve(undefined)
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** 跨站请求一律拒绝：只接受同源页面发来的调用。 */
function isSameOrigin(req) {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin === '') return true
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * 路由分发。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ dir: string, ctx: any }} env
 */
async function handle(req, res, env) {
  if (!isSameOrigin(req)) {
    sendJson(res, 403, { ok: false, error: '拒绝跨站请求' })
    return
  }

  const url = new URL(req.url || '/', 'http://localhost')
  const rest = url.pathname.slice(BASE.length)
  const parts = rest.split('/').filter(part => part.length > 0)

  // GET /api/flow-studio/health
  if (parts.length === 1 && parts[0] === 'health') {
    sendJson(res, 200, {
      ok: true,
      dir: env.dir,
      schemaVersion: 1,
      skills: Boolean(env.ctx.get && env.ctx.get('skills')),
    })
    return
  }

  // GET /api/flow-studio/skills — 供节点「引用 skills」下拉使用
  if (parts.length === 1 && parts[0] === 'skills') {
    const skills = await listSkills(env.ctx)
    sendJson(res, 200, { ok: true, skills })
    return
  }

  // /api/flow-studio/flows[/<id>]
  if (parts[0] === 'flows') {
    const id = parts[1]

    if (parts.length === 1) {
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, flows: await listFlows(env.dir) })
        return
      }
      if (req.method === 'POST') {
        const body = await readBody(req)
        const flowId = newFlowId()
        const saved = await saveFlow(env.dir, flowId, body, { name: '新流程' })
        const report = validateFlow(saved)
        sendJson(res, 200, { ok: true, flow: saved, validation: report })
        return
      }
      sendJson(res, 405, { ok: false, error: '只支持 GET / POST' })
      return
    }

    if (parts.length === 2 && checkId(id)) {
      if (req.method === 'GET') {
        const flow = await readFlow(env.dir, id)
        if (!flow) {
          sendJson(res, 404, { ok: false, error: '流程不存在' })
          return
        }
        sendJson(res, 200, { ok: true, flow, validation: validateFlow(flow) })
        return
      }
      if (req.method === 'PUT') {
        const body = await readBody(req)
        if (body === undefined) {
          sendJson(res, 400, { ok: false, error: '缺少流程内容' })
          return
        }
        const saved = await saveFlow(env.dir, id, body)
        sendJson(res, 200, { ok: true, flow: saved, validation: validateFlow(saved) })
        return
      }
      if (req.method === 'DELETE') {
        const existed = await deleteFlow(env.dir, id)
        sendJson(res, existed ? 200 : 404, existed ? { ok: true } : { ok: false, error: '流程不存在' })
        return
      }
      sendJson(res, 405, { ok: false, error: '只支持 GET / PUT / DELETE' })
      return
    }

    sendJson(res, 400, { ok: false, error: '流程 id 不合法' })
    return
  }

  sendJson(res, 404, { ok: false, error: '未知接口' })
}

/**
 * 读当前组合里的 skill 目录，供节点的「引用 skills」使用。
 * skills 服务是可选依赖：profile 没挂就返回空表，面板照常可用。
 */
async function listSkills(ctx) {
  const skills = ctx.get ? ctx.get('skills') : undefined
  if (!skills || typeof skills.list !== 'function') return []
  try {
    const entries = await skills.list()
    if (!Array.isArray(entries)) return []
    return entries
      .filter(entry => entry && typeof entry.name === 'string')
      .map(entry => ({
        name: entry.name,
        description: typeof entry.description === 'string' ? entry.description : '',
        whenToUse: typeof entry.whenToUse === 'string' ? entry.whenToUse : '',
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

/**
 * 插件入口。
 * @param {any} ctx Cordis 上下文
 */
export function apply(ctx) {
  const dir = flowsDir()

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: BASE,
    handler: (req, res) => {
      // prefix 路由会被 /api/flow-studio-x 这类同前缀路径命中，这里再挡一道。
      const path = (req.url || '').split('?')[0]
      if (path !== BASE && !path.startsWith(`${BASE}/`)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('not found')
        return
      }
      handle(req, res, { dir, ctx }).catch(error => {
        if (ctx.logger && typeof ctx.logger.warn === 'function') {
          ctx.logger.warn(`flow-studio: ${error && error.message ? error.message : String(error)}`)
        }
        if (!res.headersSent) {
          sendJson(res, 500, { ok: false, error: error && error.message ? error.message : '内部错误' })
          return
        }
        res.end()
      })
    },
  }), 'flow-studio: /api/flow-studio')
}
