/**
 * Host 数据通道：同源 fetch 到 /api/flow-studio。
 *
 * 浏览器端没有 remote/host builtin，HTTP 是唯一的跨进程通道；
 * 同源请求会自动带上 dsh 的鉴权 cookie。
 *
 * @module @feiyueve/dsh-flow-studio/client/api
 */

const BASE = '/api/flow-studio'

async function request(method, path, body) {
  const init = { method, credentials: 'same-origin', headers: {} }
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  let response
  try {
    response = await fetch(BASE + path, init)
  } catch (error) {
    throw new Error(`连不上 Host：${error && error.message ? error.message : String(error)}`)
  }
  let data = {}
  try {
    data = await response.json()
  } catch {
    data = {}
  }
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `请求失败（HTTP ${response.status}）`)
  }
  return data
}

export const api = {
  health: () => request('GET', '/health'),
  listFlows: () => request('GET', '/flows'),
  createFlow: body => request('POST', '/flows', body || {}),
  readFlow: id => request('GET', `/flows/${encodeURIComponent(id)}`),
  saveFlow: (id, flow) => request('PUT', `/flows/${encodeURIComponent(id)}`, flow),
  deleteFlow: id => request('DELETE', `/flows/${encodeURIComponent(id)}`),
  listSkills: () => request('GET', '/skills'),
}
