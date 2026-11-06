/**
 * 流程模板的 Host 侧存储：$DSH_HOME/flow-studio/flows/<id>.json
 *
 * 单个文件存一份流程，写入走「临时文件 + rename」避免半截文件；
 * 读取失败的文件跳过而不是让整个面板打不开。
 *
 * @module @feiyueve/dsh-flow-studio/store
 */

import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import { defaultFlow, makeId, normalizeFlow, summarize } from './model.js'

/** 单份流程文件的最大字节数，防止读进一份畸形大文件。 */
const MAX_FLOW_BYTES = 2 * 1024 * 1024

/** 流程 id 允许的字符集：既当文件名，也进 URL。 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** DSH 家目录：容器/多 profile 部署下 homedir() 与 DSH_HOME 并不相等，优先环境变量。 */
export function resolveHome(env) {
  const fromEnv = env && typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

/** 流程目录。每次调用都重新解析，便于测试注入。 */
export function flowsDir(home) {
  return join(home || resolveHome(process.env), 'flow-studio', 'flows')
}

/** 校验并返回 id；不合法返回 null。 */
export function checkId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id) ? id : null
}

/** 由名称生成一个稳定可用的 id。 */
export function newFlowId() {
  return `flow-${makeId('x').split('_')[1] || Date.now().toString(36)}`
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
}

/** 读一个文件并解析；不存在返回 null，解析失败抛错交给调用方决定。 */
async function readJson(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
  if (text.length > MAX_FLOW_BYTES) throw new Error(`${basename(path)} 超过 ${MAX_FLOW_BYTES} 字节`)
  return JSON.parse(text)
}

/** 原子写：先写 .tmp 再 rename，中途崩溃不会留下半份流程。 */
async function writeJsonAtomic(path, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`
  if (Buffer.byteLength(text, 'utf8') > MAX_FLOW_BYTES) {
    throw new Error(`流程超过 ${MAX_FLOW_BYTES} 字节，存不下`)
  }
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, path)
}

/**
 * 列出全部流程摘要（按更新时间倒序）。
 * 目录为空时种一份出厂模板，让人一打开面板就有东西可看。
 * @param {string} dir
 */
export async function listFlows(dir) {
  await ensureDir(dir)
  let names = []
  try {
    names = await readdir(dir)
  } catch {
    names = []
  }
  const flows = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -'.json'.length)
    if (!checkId(id)) continue
    try {
      const raw = await readJson(join(dir, name))
      if (!raw) continue
      flows.push(summarize(normalizeFlow({ ...raw, id }, '未命名流程')))
    } catch {
      // 坏文件跳过：一份手改坏的 JSON 不该让整个列表 500。
    }
  }
  if (flows.length === 0) {
    const seeded = await seedDefaultFlow(dir)
    if (seeded) flows.push(summarize(seeded))
  }
  flows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  return flows
}

/** 写入出厂模板（只在目录为空时调用一次）。 */
async function seedDefaultFlow(dir) {
  const flow = defaultFlow()
  flow.id = newFlowId()
  flow.createdAt = new Date().toISOString()
  flow.updatedAt = flow.createdAt
  try {
    await writeJsonAtomic(join(dir, `${flow.id}.json`), flow)
    return flow
  } catch {
    return null
  }
}

/**
 * 读一份流程。
 * @returns {Promise<object | null>} 不存在返回 null
 */
export async function readFlow(dir, id) {
  const safe = checkId(id)
  if (!safe) return null
  const raw = await readJson(join(dir, `${safe}.json`))
  if (!raw) return null
  return normalizeFlow({ ...raw, id: safe }, '未命名流程')
}

/**
 * 保存一份流程（整份替换语义）。id 由 Host 决定，不信任请求体里的 id。
 * @param {string} dir
 * @param {string} id
 * @param {unknown} body
 * @param {{ name?: string }} [fallback]
 */
export async function saveFlow(dir, id, body, fallback) {
  const safe = checkId(id)
  if (!safe) throw new Error('流程 id 不合法（只允许小写字母、数字、连字符）')
  await ensureDir(dir)
  const existing = await readFlow(dir, safe).catch(() => null)
  const now = new Date().toISOString()
  const flow = normalizeFlow(body, (existing && existing.name) || (fallback && fallback.name) || '未命名流程')
  flow.id = safe
  flow.createdAt = existing ? existing.createdAt : flow.createdAt || now
  flow.updatedAt = now
  await writeJsonAtomic(join(dir, `${safe}.json`), flow)
  return flow
}

/**
 * 删除一份流程。
 * @returns {Promise<boolean>} 原本是否存在
 */
export async function deleteFlow(dir, id) {
  const safe = checkId(id)
  if (!safe) return false
  try {
    await unlink(join(dir, `${safe}.json`))
    return true
  } catch (error) {
    if (error && error.code === 'ENOENT') return false
    throw error
  }
}
