#!/usr/bin/env node
/**
 * `scripts/e2e-bpmn.sh` 的挂载隔离检查（复审 R4）桩演练。
 *
 * 不启动容器、不执行 pnpm install：把脚本里 `# >>> e2e-bpmn:mount-check` 到
 * `# <<< e2e-bpmn:mount-check` 之间的真实函数原样抽出来，只把 `docker` 换成桩
 * （inspect 返回挂载表，exec 返回真实路径），验证：
 *   - 宿主 HOME / ~/.dsh 暴露 → 拒绝；
 *   - 测试台根内的**嵌套 bind**（`profile/node_modules`、`dt/cache` 等）→ 拒绝；
 *   - 只有 `/testbed` 根挂载被认可；
 *   - 校验失败时后续 `pnpm install` 一行都不会执行。
 *
 * 运行：node test/e2e-mount-isolation.test.mjs
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
mkdirSync(join(repoRoot, '.tmp'), { recursive: true })

let checks = 0
let assertions = 0

async function check(name, fn) {
  try {
    await fn()
    checks += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    console.log(`  ✗ ${name}`)
    console.log('    ' + String((error && error.message) || error))
    process.exitCode = 1
  }
}

function ok(value, message) {
  assertions += 1
  assert.ok(value, message)
}

function eq(actual, expected, message) {
  assertions += 1
  assert.equal(actual, expected, message)
}

function extractMountCheck() {
  const source = readFileSync(join(repoRoot, 'scripts', 'e2e-bpmn.sh'), 'utf8')
  const begin = source.indexOf('# >>> e2e-bpmn:mount-check')
  const end = source.indexOf('# <<< e2e-bpmn:mount-check')
  ok(begin >= 0 && end > begin, '脚本里必须保留 e2e-bpmn:mount-check 抽取标记')
  return source.slice(begin, end)
}

/**
 * 生成桩脚本并执行。
 *
 * @param {string[]} mounts 每条形如 `type\u001fsource\u001fdestination`
 * @param {string[]} realpaths 每条形如 `guestTarget=resolved`（桩里模拟 symlink 解析）
 * @returns {{ status: number, output: string, installed: boolean }}
 */
function runMountCheck(root, mounts, realpaths = []) {
  const harness = join(root, 'mount-check.sh')
  const installLog = join(root, 'install.log')
  const script = `#!/usr/bin/env bash
set -uo pipefail

CONTAINER="stub-testbed"
GUEST_ROOT="/testbed"
GUEST_HOME="/testbed/home"
GUEST_PROFILE="/testbed/home/profiles/web"
GUEST_PREFIX="/testbed/prefix"
GUEST_DT="/testbed/dt"
GUEST_LOGS="/testbed/logs"
GUEST_LOG="/testbed/logs/dsh-web.log"
export HOME="/home/tester"
INSTALL_LOG="\${INSTALL_LOG:?}"

# 桩：按 STUB_REALPATHS（target=resolved）模拟容器内 realpath / symlink 解析。
stub_realpath() {
  local target="\$1" line t r
  while IFS= read -r line; do
    [ -n "\$line" ] || continue
    t="\${line%%=*}"
    r="\${line#*=}"
    if [ "\$target" = "\$t" ]; then printf '%s' "\$r"; return; fi
    case "\$target" in
      "\$t"/*) printf '%s' "\$r\${target#"$t"}"; return ;;
    esac
  done <<< "\${STUB_REALPATHS:-}"
  printf '%s' "\$target"
}

# 桩：只实现 verify_mount_isolation 用到的 inspect / exec。
docker() {
  if [ "\${1:-}" = "inspect" ]; then
    printf '%b' "\${STUB_MOUNTS:-}"
    return 0
  fi
  if [ "\${1:-}" = "exec" ]; then
    local targets="" arg
    for arg in "\$@"; do
      case "\$arg" in
        E2E_REALPATH_TARGETS=*) targets="\${arg#E2E_REALPATH_TARGETS=}" ;;
      esac
    done
    while IFS= read -r target; do
      [ -n "\$target" ] || continue
      printf '%s\\t%s\\n' "\$target" "\$(stub_realpath "\$target")"
    done <<< "\$targets"
    return 0
  fi
  return 1
}

${extractMountCheck()}

# 与真实脚本同构：校验失败就直接退出，后面的安装不会执行。
set -e
verify_mount_isolation
printf 'pnpm install --no-frozen-lockfile\\n' >> "$INSTALL_LOG"
`
  writeFileSync(harness, script, { encoding: 'utf8', mode: 0o755 })
  rmSync(installLog, { force: true })
  let status = 0
  let output = ''
  try {
    output = execFileSync('bash', [harness], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        INSTALL_LOG: installLog,
        STUB_MOUNTS: mounts.map(line => `${line}\n`).join(''),
        STUB_REALPATHS: realpaths.map(line => `${line}\n`).join(''),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    status = typeof error.status === 'number' ? error.status : 1
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
  return { status, output, installed: existsSync(installLog) }
}

const SEP = '\u001f'
const mount = (type, source, destination) => `${type}${SEP}${source}${SEP}${destination}`

let sandbox = ''

await check('R4：只认可根挂载，嵌套 bind（profile/node_modules、dt/cache）和宿主暴露都在安装前拒绝', async () => {
  sandbox = mkdtempSync(join(repoRoot, '.tmp', 'e2e-mount-'))
  try {
    const cases = [
      {
        name: '宿主 HOME 暴露',
        mounts: [mount('bind', '/home/tester', '/mnt/home')],
        pattern: /宿主 home \/ ~\/\.dsh/,
      },
      {
        name: '宿主 ~/.dsh 暴露',
        mounts: [mount('bind', '/home/tester/.dsh', '/mnt/dsh')],
        pattern: /宿主 home \/ ~\/\.dsh/,
      },
      {
        name: 'bind 覆盖 guest profile',
        mounts: [mount('bind', '/srv/profile', '/testbed/home/profiles/web')],
        pattern: /嵌套 bind/,
      },
      {
        name: 'bind 覆盖 guest profile/node_modules',
        mounts: [mount('bind', '/srv/node_modules', '/testbed/home/profiles/web/node_modules')],
        pattern: /嵌套 bind/,
      },
      {
        name: 'bind 覆盖 guest dt/cache',
        mounts: [mount('bind', '/srv/cache', '/testbed/dt/cache')],
        pattern: /嵌套 bind/,
      },
      {
        name: 'bind 覆盖根内其它子目录（未认可）',
        mounts: [mount('bind', '/srv/other', '/testbed/other')],
        pattern: /嵌套 bind/,
      },
      {
        name: 'bind 作为写入根祖先（双向重叠）',
        mounts: [mount('bind', '/srv/prefix', '/')],
        pattern: /双向重叠/,
      },
      {
        name: 'F7：symlink 解析后的目录与更深 bind 互为子孙',
        mounts: [
          mount('bind', '/srv/testbed', '/testbed'),
          mount('bind', '/srv/host-pnpm-store', '/outside/modules/.pnpm'),
        ],
        realpaths: [
          '/testbed/home/profiles/web=/outside/modules',
          '/testbed/home/profiles/web/package.json=/outside/modules/package.json',
          '/testbed/home/profiles/web/node_modules=/outside/modules/node_modules',
        ],
        pattern: /重叠（祖先或子孙）/,
      },
    ]
    for (const item of cases) {
      const result = runMountCheck(sandbox, item.mounts, item.realpaths || [])
      ok(result.status !== 0, `${item.name}：必须拒绝（实际 exit=${result.status}）`)
      ok(item.pattern.test(result.output), `${item.name}：拒绝原因必须可读（实际：${result.output.trim()}）`)
      eq(result.installed, false, `${item.name}：拒绝后不得执行 pnpm install`)
    }

    // 唯一认可的挂载：/testbed 根挂载（来源不能是宿主 home 本身 / ~/.dsh）。
    const accepted = runMountCheck(sandbox, [mount('bind', '/home/tester/dsh-testbed-bpmn', '/testbed')])
    eq(accepted.status, 0, `根挂载必须接受（实际：${accepted.output.trim()}）`)
    eq(accepted.installed, true, '校验通过后才会执行 pnpm install')
    eq(readFileSync(join(sandbox, 'install.log'), 'utf8').trim(), 'pnpm install --no-frozen-lockfile',
      '通过后安装命令只会执行一次')

    // 合法 symlink（解析后仍在 /testbed 下）不能被双向检查误杀。
    rmSync(join(sandbox, 'install.log'), { force: true })
    const symlinkInside = runMountCheck(
      sandbox,
      [mount('bind', '/srv/testbed', '/testbed')],
      ['/testbed/home/profiles/web=/testbed/shared/web'],
    )
    eq(symlinkInside.status, 0, `根内 symlink 必须接受（实际：${symlinkInside.output.trim()}）`)
    eq(symlinkInside.installed, true, '根内 symlink 后仍执行安装')
  } finally {
    if (sandbox !== '') rmSync(sandbox, { recursive: true, force: true })
  }
})

console.log(`\ne2e-mount-isolation: ${checks} 组 / ${assertions} 条断言通过`)
