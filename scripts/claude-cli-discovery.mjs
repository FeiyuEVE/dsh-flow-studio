#!/usr/bin/env node
/**
 * Claude CLI 发现（0.14.5 m6）。
 *
 * 复审缺陷：`scripts/claude-smoke.mjs` 与 Claude 适配器的「真实 CLI」测试只查几个固定
 * 路径（`/usr/local/bin/claude` 等），PATH 里有可执行的 `claude` 也发现不了，于是把
 * 「没找到」记成 `skipped:true`。**找到 CLI 不等于通道验收通过**：本模块只回答
 * 「CLI 在哪」，真实 probe / 握手仍由适配器与 smoke 自己跑。
 *
 * 规则（smoke、真实 probe 测试共用这一份）：
 *   1. `CLAUDE_BIN` 显式路径优先；它坏了（不存在 / 不可执行 / 是目录）也**记录尝试**，
 *      然后继续搜 PATH（不因为显式路径写错就放弃）。
 *   2. 否则按 `PATH` 逐目录找 `claude`（Windows 额外试 `claude.cmd` / `claude.exe`）。
 *   3. 只有**普通文件且可执行**才算找到；目录、不可执行文件都记 `attempts` 里的具体原因。
 *   4. 返回值 `{ found, bin, source, attempts }`：`attempts` 是可复核的证据
 *      （`{source, path, ok, reason}`），smoke 把它一起打出来。
 *
 * @module @feiyueve/dsh-flow-studio/scripts/claude-cli-discovery
 */

import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/** 显式指定 CLI 路径的环境变量（优先于 PATH）。 */
export const CLAUDE_BIN_ENV = 'CLAUDE_BIN'

/** PATH 里按平台尝试的可执行名。 */
const WINDOWS_NAMES = Object.freeze(['claude.cmd', 'claude.exe', 'claude'])
const POSIX_NAMES = Object.freeze(['claude'])

/**
 * 检查一个候选路径是不是可执行的 CLI。
 *
 * @param {string} path
 * @param {string} platform
 * @returns {{ok: boolean, reason: string|null}}
 */
export function checkClaudeCandidate(path, platform = process.platform) {
  try {
    const stat = statSync(path)
    if (!stat.isFile()) return { ok: false, reason: 'not-a-regular-file' }
    if (platform === 'win32') return { ok: true, reason: null }
    try {
      accessSync(path, constants.X_OK)
    } catch (error) {
      const code = error && error.code
      return { ok: false, reason: code === 'EACCES' || code === 'EPERM' ? 'not-executable' : 'not-executable' }
    }
    return { ok: true, reason: null }
  } catch (error) {
    const code = error && error.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, reason: 'not-found' }
    if (code === 'EACCES' || code === 'EPERM') return { ok: false, reason: 'not-executable' }
    return { ok: false, reason: code ? String(code) : 'stat-failed' }
  }
}

/**
 * 按 `CLAUDE_BIN` → `PATH` 的顺序发现 claude CLI。
 *
 * @param {{env?: NodeJS.ProcessEnv, platform?: string, pathValue?: string}} [options]
 * @returns {{found: boolean, bin: string|null, source: string|null,
 *   attempts: Array<{source: string, path: string, ok: boolean, reason: string|null}>}}
 */
export function discoverClaudeCli(options = {}) {
  const env = options.env && typeof options.env === 'object' ? options.env : process.env
  const platform = typeof options.platform === 'string' ? options.platform : process.platform
  const attempts = []
  const explicit = typeof env[CLAUDE_BIN_ENV] === 'string' ? env[CLAUDE_BIN_ENV].trim() : ''
  if (explicit !== '') {
    const check = checkClaudeCandidate(explicit, platform)
    attempts.push({ source: CLAUDE_BIN_ENV, path: explicit, ok: check.ok, reason: check.reason })
    if (check.ok) return { found: true, bin: explicit, source: CLAUDE_BIN_ENV, attempts }
  }
  const pathValue = typeof options.pathValue === 'string'
    ? options.pathValue
    : (typeof env.PATH === 'string' ? env.PATH : '')
  const names = platform === 'win32' ? WINDOWS_NAMES : POSIX_NAMES
  for (const dir of pathValue.split(platform === 'win32' ? ';' : delimiter)) {
    if (dir === '') continue
    for (const name of names) {
      const candidate = join(dir, name)
      const check = checkClaudeCandidate(candidate, platform)
      if (check.ok) {
        attempts.push({ source: 'PATH', path: candidate, ok: true, reason: null })
        return { found: true, bin: candidate, source: 'PATH', attempts }
      }
      // 不存在是常态（PATH 很长），只在「存在但不可用」时留证据。
      if (check.reason && check.reason !== 'not-found') {
        attempts.push({ source: 'PATH', path: candidate, ok: false, reason: check.reason })
      }
    }
  }
  return { found: false, bin: null, source: null, attempts }
}

export default discoverClaudeCli
