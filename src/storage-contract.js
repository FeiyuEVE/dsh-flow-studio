/**
 * 存储契约（中性模块）：新域（definitions / instances）与旧域退役后的**唯一**
 * 公共存储口径。
 *
 * 这里只放三类东西：
 *   1. 根目录解析（`DSH_HOME` 优先于 `homedir()`，容器 / 多 profile 部署下两者不等）；
 *   2. 落盘 id 的字符集与路径穿越防线（`checkRunId` 同时用于 definitionId /
 *      instanceId / activityId / run id，语义是「能安全当一级目录名」）；
 *   3. 事件落盘的硬上限（单条字节数 / 单批条数），供实例事件存储复用。
 *
 * 不含任何旧运行域业务（run.json / 事件聚合 / 执行链）；那些已随 0.14.0 退役。
 *
 * @module @feiyueve/dsh-flow-studio/storage-contract
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * DSH 家目录：容器 / 多 profile 部署下 `homedir()` 与 `DSH_HOME` 并不相等，优先环境变量。
 *
 * 省略 `env` 时必须回落到 `process.env`（旧 `store.flowsDir()` 的口径）：
 * dsh 的进程里 `HOME` 可能还是 `/root`，真正的家目录由宿主以 `DSH_HOME` 注入；
 * 丢掉这层兜底会把数据根解析到 `~/.dsh`，容器里就是两套目录。
 */
export function resolveHome(env) {
  const source = env === undefined || env === null ? process.env : env
  const fromEnv = source && typeof source.DSH_HOME === 'string' ? source.DSH_HOME.trim() : ''
  if (fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

/** flow-studio 数据根：`<DSH_HOME>/flow-studio`（definitions/ 与 instances/ 的父目录）。 */
export function flowStudioDir(env) {
  return join(resolveHome(env), 'flow-studio')
}

/** 单条事件序列化后的上限（字节，不含行尾换行）。 */
export const MAX_EVENT_BYTES = 8 * 1024

/** 单批追加的事件条数上限。 */
export const MAX_BATCH_EVENTS = 200

/** 落盘 id 的字符集（definitionId / instanceId / activityId / runId）。 */
export const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

/**
 * 校验一个落盘 id。除了契约给的字符集，还挡掉 `.`、`..` 与点开头
 * （会撞 `.index` / `.tmp` 这类内部命名），防路径穿越。
 *
 * @param {unknown} value
 * @returns {string | null} 合法时原样返回，否则 null
 */
export function checkRunId(value) {
  if (typeof value !== 'string') return null
  if (!ID_PATTERN.test(value)) return null
  if (value === '.' || value === '..') return null
  if (value.startsWith('.')) return null
  return value
}
