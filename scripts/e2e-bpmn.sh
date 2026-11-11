#!/usr/bin/env bash
# 新 BPMN 域（definitions / instances / 人工任务 / 画布 chunk）的容器测试台验收。
#
# 用法：
#   bash scripts/e2e-bpmn.sh          # 打包当前仓库 → 装进测试台容器 → 重启容器内 dsh → 只走 HTTP 跑完整链路
#   TESTBED_CONTAINER=dsh-testbed-x TESTBED_PORT=3120 bash scripts/e2e-bpmn.sh
#
# 环境变量覆盖：TESTBED_CONTAINER（默认 dsh-testbed-bpmn）、TESTBED_PORT（默认 3110）、
#   E2E_RUN_ID（测试用；默认「时间戳-pid」，决定本次证据子目录名）、
#   E2E_PREFLIGHT_ONLY=1（测试用：只跑前置身份校验后退出；若走 bootstrap 会启动一次 dsh，
#   但不做安装 / 杀进程）。
#
# 边界：
#   - 只读宿主 dsh-web（systemctl is-active / ActiveEnterTimestamp），绝不重启、不碰宿主 ~/.dsh。
#   - **先身份校验、后破坏性操作**：容器在跑 / 端口映射 / PID+NET namespace 隔离 / 挂载 /
#     监听 3080 的进程 / 用容器日志令牌登录 303 全部通过，才允许安装 profile 与杀进程。
#   - 只终止本容器内**监听 3080 的 dsh**（socket inode 反查 PID，再核对 comm/cwd/cmdline），
#     不按 `pkill node` 一把杀。
#   - 容器内测试台根 /testbed；证据按运行隔离到仓库 .tmp/e2e-bpmn/<runId>/（已 gitignore），
#     并用 .tmp/e2e-bpmn/.e2e-bpmn.lock 串行化——并行运行会互相改 lib/ 与测试台，直接拒绝。
#     旧版本平铺在 .tmp/e2e-bpmn/ 下的证据只作兼容读取，不删除。
#   - 安装必须走包管理器：拷 tgz → sed profile 依赖 → pnpm install，不手工解包。
#
# 为什么这里单独起一个 FLOW_STUDIO_TOKEN：
#   index.js 的鉴权是两层——宿主 connection 凭据（cookie）在前，插件令牌（Bearer）在后。
#   只有两层都配置，才能同时验到「无 cookie 被拒」与「有 cookie、无插件令牌的写请求被拒」。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
CONTAINER="${TESTBED_CONTAINER:-dsh-testbed-bpmn}"
PORT="${TESTBED_PORT:-3110}"
# 测试用：只跑前置身份校验就退出，供无副作用演练（正常验收不需要设置）。
PREFLIGHT_ONLY="${E2E_PREFLIGHT_ONLY:-0}"

GUEST_ROOT="/testbed"
GUEST_HOME="$GUEST_ROOT/home"
GUEST_PROFILE="$GUEST_HOME/profiles/web"
GUEST_PREFIX="$GUEST_ROOT/prefix"
GUEST_DT="$GUEST_ROOT/dt"
GUEST_LOGS="$GUEST_ROOT/logs"
GUEST_LOG="$GUEST_LOGS/dsh-web.log"
# 由 /health 的 dir（.../flow-studio/flows）推出 BPMN 数据根，清理时用真实根而不是硬编码。
BPMN_BASE=""

BASE="http://127.0.0.1:$PORT/api/flow-studio"
ORIGIN="http://127.0.0.1:$PORT"
VERSION="$(node -p "require('$REPO/package.json').version")"
# 证据按运行隔离：runId 带时间戳与 pid；旧版本的平铺文件不再读写。
EVID_BASE="$REPO/.tmp/e2e-bpmn"
RUN_ID="${E2E_RUN_ID:-$(date +%Y%m%dT%H%M%S)-$$}"
EVID="$EVID_BASE/$RUN_ID"
LOCK="$EVID_BASE/.e2e-bpmn.lock"
LOCK_DIR="$LOCK.d"
JAR="$EVID/cookies.txt"
PRE_JAR="$EVID/preflight-cookies.txt"
TOKEN="bpmn-$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))')"

say() { printf '\033[1;34m==> \033[0m%s\n' "$*"; }
ok()  { printf '\033[1;32m ✓ \033[0m%s\n' "$*"; }
die() { printf '\033[1;31m失败: \033[0m%s\n' "$*" >&2; exit 1; }

dex() { docker exec -i "$CONTAINER" "$@"; }
# 容器内 sh：DSH_HOME 指向测试台 home，PATH 含 guest prefix（pnpm / dsh）。
dex_sh() {
  local script="$1"; shift
  docker exec -i \
    -e "DSH_HOME=$GUEST_HOME" \
    -e "PATH=$GUEST_PREFIX/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    "$@" "$CONTAINER" sh -c "$script"
}

# 所有 API 都带宿主 cookie + 插件令牌；两条鉴权链都要真的被验到。
req() { curl -s -m 15 -b "$JAR" -H "Authorization: Bearer $TOKEN" "$@"; }
get_api() {
  local path="$1" out="$2"
  curl -s -m 15 -b "$JAR" -H "Authorization: Bearer $TOKEN" -o "$out" -w '%{http_code}' "$BASE$path"
}
post_json() {
  local path="$1" body_file="$2" out="$3"
  curl -s -m 15 -b "$JAR" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -X POST --data-binary "@$body_file" -o "$out" -w '%{http_code}' "$BASE$path"
}
del_code() {
  local path="$1"
  curl -s -m 15 -b "$JAR" -H "Authorization: Bearer $TOKEN" -X DELETE -o /dev/null -w '%{http_code}' "$BASE$path"
}

# 从 stdin 的 JSON 里求值一个表达式；坏 JSON 输出空串（随后断言失败会打印取证）。
jqr() {
  node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String(eval(process.argv[1])))}catch(e){process.stdout.write("")}})' "$1"
}

assert_eq() {
  local actual="$1" expected="$2" msg="$3"
  [ "$actual" = "$expected" ] || die "$msg（实际：$actual，期望：$expected）"
}
assert_code() {
  local actual="$1" msg="$2"; shift 2
  for allowed in "$@"; do [ "$actual" = "$allowed" ] && return 0; done
  die "$msg（HTTP $actual，期望 $*）"
}
assert_true() {
  local actual="$1" msg="$2"
  [ "$actual" = "true" ] || die "$msg（实际：${actual:-空}）"
}

# ---------------------------------------------------------------------------
# 容器身份校验（review-0136 F6）
#
# 破坏性操作之前必须先证明「宿主 $PORT 上的服务就是容器 $CONTAINER 里的这次 dsh」：
# 端口映射、PID/NET namespace、挂载、监听 3080 的进程、容器日志令牌登录 303。
# ---------------------------------------------------------------------------

# 容器内监听 3080 的进程（JSON 数组：pid / comm / cwd / cmdline）。
# 用 node 读 /proc/net/tcp{,6} 的 LISTEN socket inode，再按 fd 反查 PID，
# 不依赖容器里有没有 ss / lsof；宿主网络或共享 PID namespace 会在上层被拒。
guest_listeners() {
  docker exec -i \
    -e "PATH=$GUEST_PREFIX/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    "$CONTAINER" node -e '
const fs = require("fs")
const portHex = (3080).toString(16).toUpperCase().padStart(4, "0")
const inodes = new Set()
for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
  let text
  try { text = fs.readFileSync(file, "utf8") } catch { continue }
  for (const line of text.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 10) continue
    if (!cols[1].endsWith(":" + portHex)) continue
    if (cols[3] !== "0A") continue
    inodes.add(cols[9])
  }
}
const read = path => { try { return fs.readFileSync(path, "utf8") } catch { return "" } }
const readlink = path => { try { return fs.readlinkSync(path) } catch { return "" } }
const rows = []
for (const name of fs.readdirSync("/proc")) {
  if (!/^[0-9]+$/.test(name)) continue
  const dir = "/proc/" + name
  let fds
  try { fds = fs.readdirSync(dir + "/fd") } catch { continue }
  let hit = false
  for (const fd of fds) {
    const match = /^socket:\[([0-9]+)\]$/.exec(readlink(dir + "/fd/" + fd))
    if (match && inodes.has(match[1])) { hit = true; break }
  }
  if (!hit) continue
  rows.push({
    pid: Number(name),
    comm: read(dir + "/comm").trim(),
    cwd: readlink(dir + "/cwd"),
    cmdline: read(dir + "/cmdline").split("\0").filter(Boolean).join(" "),
  })
}
process.stdout.write(JSON.stringify(rows))
'
}

# 校验监听 3080 的进程确实是本容器的 dsh；失败打印期望/实际并退出。PID 列表写入
# VERIFIED_PIDS（不用命令替换，确保 die 真的终止主脚本而不是只退出子 shell）。
VERIFIED_PIDS=""
verify_guest_dsh() {
  local raw="$1" count pids bad
  count="$(printf '%s' "$raw" | jqr 'Array.isArray(j)?j.length:-1')"
  case "$count" in
    ''|-1)
      die "容器 $CONTAINER 内读不出 /proc 监听信息（期望读到监听 3080 的 dsh 进程，实际：$(printf '%.300s' "$raw")）" ;;
    0)
      die "容器 $CONTAINER 内没有进程监听 3080——宿主 $PORT 上的服务不属于该容器（期望该容器内有一个 dsh 监听 3080）" ;;
  esac
  pids="$(printf '%s' "$raw" | jqr 'j.map(x=>x.pid).join(" ")')"
  [ -n "$pids" ] || die "容器 $CONTAINER 内监听 3080 的 PID 解析失败（实际：$(printf '%.300s' "$raw")）"
  bad="$(printf '%s' "$raw" | jqr 'j.filter(x=>x.comm!=="node"&&x.comm!=="MainThread").map(x=>"pid "+x.pid+" comm="+x.comm).join("；")')"
  [ -z "$bad" ] || die "监听 3080 的进程 comm 不是 node/MainThread（期望 node|MainThread，实际：$bad）"
  bad="$(printf '%s' "$raw" | jqr "j.filter(x=>!String(x.cwd).startsWith('$GUEST_ROOT/')).map(x=>'pid '+x.pid+' cwd='+x.cwd).join('；')")"
  [ -z "$bad" ] || die "监听 3080 的进程 cwd 不在测试台根 $GUEST_ROOT 下（期望 $GUEST_ROOT/...，实际：$bad）"
  bad="$(printf '%s' "$raw" | jqr "j.filter(x=>!String(x.cmdline).includes('$GUEST_PREFIX/bin/dsh')).map(x=>'pid '+x.pid+' cmdline='+x.cmdline).join('；')")"
  [ -z "$bad" ] || die "监听 3080 的进程不是测试台 dsh（期望 cmdline 含 $GUEST_PREFIX/bin/dsh，实际：$bad）"
  VERIFIED_PIDS="$pids"
}

# 宿主侧 namespace 标识：优先 /proc/1/ns/<kind>，读不到（受限沙箱 / 权限）退到 /proc/self。
host_ns() {
  local value=""
  value="$(readlink "/proc/1/ns/$1" 2>/dev/null || true)"
  [ -n "$value" ] || value="$(readlink "/proc/self/ns/$1" 2>/dev/null || true)"
  printf '%s' "$value"
}

# 容器内某个 namespace 的标识（readlink /proc/1/ns/<kind>）。
guest_ns() {
  docker exec -i "$CONTAINER" sh -c "readlink /proc/1/ns/$1" 2>/dev/null | tr -d '\r\n' || true
}

# 启动容器内 dsh（一次性插件令牌）并等到日志就绪 + 宿主端口可达。
# 两条路径共用：前置 bootstrap（容器里没有在跑实例）与第 4 步重启。
STARTED_HTTP_CODE=""
start_guest_dsh() {
  dex_sh "cd $GUEST_ROOT/workspace && setsid nohup node $GUEST_PREFIX/bin/dsh --profile web --port 3080 --no-open > $GUEST_LOG 2>&1 < /dev/null & echo started" \
    -e FLOW_STUDIO_TOKEN="$TOKEN" >/dev/null
  local ready=0
  for _ in $(seq 1 80); do
    if dex_sh "grep -q '^dsh web: http' $GUEST_LOG" >/dev/null 2>&1; then ready=1; break; fi
    sleep 0.5
  done
  [ "$ready" = "1" ] || { dex_sh "tail -40 $GUEST_LOG" || true; die "容器内 dsh 未在 40s 内启动"; }
  local port_up=0 code=""
  for _ in $(seq 1 40); do
    code="$(curl -s -m 1 -o /dev/null -w '%{http_code}' "$ORIGIN/" 2>/dev/null || true)"
    [ "$code" != "000" ] && { port_up=1; break; }
    sleep 0.5
  done
  [ "$port_up" = "1" ] || die "容器内 dsh 启动后端口 $PORT 仍不可达"
  STARTED_HTTP_CODE="$code"
}

# 容器内路径的 dev:inode（node 一定在，避免宿主 stat 与 busybox 参数差异）。
guest_path_id() {
  docker exec -i -e "PATH=$GUEST_PREFIX/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    -e "TARGET_PATH=$1" "$CONTAINER" node -e '
try {
  const st = require("fs").statSync(process.env.TARGET_PATH)
  process.stdout.write(st.dev + ":" + st.ino)
} catch {
  process.exit(3)
}
'
}

EVID_READY=0
PREFLIGHT_OK=0
BOOTSTRAP=0
LOCK_KIND=""
on_exit() {
  local rc=$1
  if [ "$rc" -ne 0 ] && [ "$EVID_READY" = "1" ]; then
    printf '\n'
    if [ "$PREFLIGHT_OK" = "1" ]; then
      say "失败取证（rc=$rc）：容器日志尾部 + 最近 HTTP 响应"
      docker exec -i "$CONTAINER" sh -c "tail -80 $GUEST_LOG 2>/dev/null" 2>/dev/null || true
      for f in "$EVID/last-response.json" "$EVID/definition-save.json" "$EVID/instance.json" "$EVID/events.json"; do
        [ -f "$f" ] || continue
        printf '\n--- %s ---\n' "${f#"$REPO"/}"
        head -c 4000 "$f" || true
        printf '\n'
      done
    else
      say "失败发生在容器身份校验之前/之中：不读取该容器日志、不改测试台，现场未被触碰"
    fi
    printf '\n证据目录：%s（本次现场保留；其它运行的证据不会被清理）\n' "${EVID#"$REPO"/}"
  fi
  if [ "$LOCK_KIND" = "mkdir" ]; then
    rm -rf "$LOCK_DIR"
  fi
}
trap 'on_exit $?' EXIT

# 串行化：并发运行会同时改 lib/、同一容器与同一端口，必须互斥。
mkdir -p "$EVID_BASE"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK"
  flock -n 9 || die "另一个 e2e-bpmn 运行正在使用测试台（锁 ${LOCK#"$REPO"/}）；并行运行会互相改构建产物与测试台，已拒绝"
else
  mkdir "$LOCK_DIR" 2>/dev/null || die "另一个 e2e-bpmn 运行正在使用测试台（锁 ${LOCK_DIR#"$REPO"/}）"
  printf '%s\n' "$$" >"$LOCK_DIR/pid"
  LOCK_KIND="mkdir"
fi
mkdir -p "$EVID"
EVID_READY=1

# 每次跑都用新的定义 id，避免上一轮残留把「新建」断言变成「更新」。
DEF_ID="e2e-bpmn-$(date +%s)-$$"
ACTIVITY_ID="e2e-user-task"

say "0. 宿主隔离基线（只读）"
HOST_DSH_ACTIVE_BEFORE="$(systemctl is-active dsh-web 2>/dev/null || true)"
HOST_DSH_START_BEFORE="$(systemctl show -p ActiveEnterTimestamp --value dsh-web 2>/dev/null || true)"
printf '    dsh-web active=%s ActiveEnterTimestamp=%s\n' "$HOST_DSH_ACTIVE_BEFORE" "$HOST_DSH_START_BEFORE"

say "1. 前置检查：先在容器身份 / 端口对应上失败，绝不先杀进程或装 profile"
[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)" = "true" ] \
  || die "容器 $CONTAINER 不存在或未运行"
ok "容器 $CONTAINER 在运行"

# 1a. 端口映射：容器 3080 的每一条宿主映射都必须正好是 TESTBED_PORT。
PORT_MAP="$(docker port "$CONTAINER" 3080 2>/dev/null || true)"
[ -n "$PORT_MAP" ] || die "容器 $CONTAINER 没有发布容器端口 3080（期望映射到宿主 $PORT，实际：docker port 为空）"
MAPPED_PORTS="$(printf '%s\n' "$PORT_MAP" | sed -E 's/.*:([0-9]+)$/\1/' | sort -u)"
[ -n "$MAPPED_PORTS" ] || die "读不出容器 $CONTAINER 的 3080 宿主端口（docker port 实际：$PORT_MAP）"
BAD_MAPPED=""
for mapped in $MAPPED_PORTS; do
  case "$mapped" in
    ''|*[!0-9]*) BAD_MAPPED="$BAD_MAPPED $mapped" ;;
    *) [ "$mapped" = "$PORT" ] || BAD_MAPPED="$BAD_MAPPED $mapped" ;;
  esac
done
[ -z "$BAD_MAPPED" ] || die "端口映射错配：期望宿主端口 $PORT（TESTBED_PORT），但容器 $CONTAINER 的 3080 映射到了$(printf '%s' "$BAD_MAPPED")（docker port 实际：$(printf '%s' "$PORT_MAP" | tr '\n' ' ')）"
ok "端口映射对应：容器 $CONTAINER:3080 → 宿主 $PORT（docker port：$(printf '%s' "$PORT_MAP" | tr '\n' ' ')）"

# 端口可达性不在这里单独要求：有实例时由下面的 303 登录证明，无实例时走 bootstrap 再等端口。

# 1b. PID / NET namespace 必须与宿主隔离；共享 namespace 时 /proc 扫描与端口归属都不可信。
PID_MODE="$(docker inspect -f '{{.HostConfig.PidMode}}' "$CONTAINER" 2>/dev/null || true)"
case "$PID_MODE" in
  host|container:*) die "容器 $CONTAINER 的 PidMode=$PID_MODE（期望私有 PID namespace；共享时会误伤宿主或别的容器进程）" ;;
esac
NET_MODE="$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$CONTAINER" 2>/dev/null || true)"
case "$NET_MODE" in
  host|container:*) die "容器 $CONTAINER 的 NetworkMode=$NET_MODE（期望私有 network namespace；共享时宿主端口 $PORT 不能证明属于该容器）" ;;
esac
HOST_PID_NS="$(host_ns pid)"
GUEST_PID_NS="$(guest_ns pid)"
[ -n "$HOST_PID_NS" ] || die "宿主读不到 /proc/1/ns/pid 或 /proc/self/ns/pid"
[ -n "$GUEST_PID_NS" ] || die "容器 $CONTAINER 内读不到 /proc/1/ns/pid（期望独立 PID namespace）"
[ "$HOST_PID_NS" != "$GUEST_PID_NS" ] \
  || die "容器 $CONTAINER 与宿主共用 PID namespace（宿主=$HOST_PID_NS，容器=$GUEST_PID_NS）：/proc 扫描会看到宿主进程，拒绝继续"
HOST_NET_NS="$(host_ns net)"
GUEST_NET_NS="$(guest_ns net)"
[ -n "$HOST_NET_NS" ] || die "宿主读不到 /proc/1/ns/net 或 /proc/self/ns/net"
[ -n "$GUEST_NET_NS" ] || die "容器 $CONTAINER 内读不到 /proc/1/ns/net（期望独立 network namespace）"
[ "$HOST_NET_NS" != "$GUEST_NET_NS" ] \
  || die "容器 $CONTAINER 与宿主共用 network namespace（宿主=$HOST_NET_NS，容器=$GUEST_NET_NS）：宿主端口 $PORT 不能证明属于该容器，拒绝继续"
ok "namespace 隔离：PID（宿主 $HOST_PID_NS / 容器 $GUEST_PID_NS）、NET（宿主 $HOST_NET_NS / 容器 $GUEST_NET_NS）均独立"

# 1c. 挂载 / 写入路径：宿主 home（含祖先目录）与宿主 ~/.dsh 都不能进测试台；
#     容器内真正要写的目录必须落在容器自己的文件系统上，不能经由挂载或符号链接。
#
# 只比较 guest home 与宿主 ~/.dsh 的 inode 不够：把宿主 $HOME 挂到别处时 guest
# home 仍是另一份目录，而 profile 可以是指向宿主 ~/.dsh/profiles/web 的符号链接
# （复审 N3）。这里同时做三件事：
#   ① 每一条挂载的 Source 不能是宿主 HOME / 它的祖先 / 宿主 ~/.dsh（含其子孙）；
#   ② 每一条挂载的 Destination 不能覆盖测试台要写的目录；
#   ③ 解析 profile、日志、安装目录等的**真实路径**，不能落在任何 bind 挂载下。
#
# >>> e2e-bpmn:mount-check —— 这段函数会被 .tmp/e2e-bpmn-selftest 单独抽取做桩演练
# 规范化宿主路径：不要求目标存在（realpath -m 语义）。
norm_path() {
  local input="$1"
  [ -n "$input" ] || { printf '%s' ''; return 0; }
  if command -v realpath >/dev/null 2>&1; then
    realpath -m -- "$input" 2>/dev/null && return 0
  fi
  printf '%s' "$input"
}

# PATH 是否等于 PREFIX 或位于其下（PREFIX=/ 时覆盖一切绝对路径）。
path_within() {
  local prefix="$1" path="$2"
  [ -n "$prefix" ] && [ -n "$path" ] || return 1
  [ "$prefix" = "/" ] && return 0
  [ "$path" = "$prefix" ] && return 0
  case "$path" in
    "$prefix"/*) return 0 ;;
  esac
  return 1
}

# Mounts 三元组：Type / Source / Destination，用 U+001F 分隔。
# 不能用 tab：tmpfs 的 Source 为空，而 read 对空白 IFS 会折叠连续分隔符，
# 把「空 Source + 目的地」错位成「Source=目的地」，从而漏掉整条挂载。
mount_table() {
  docker inspect -f '{{range .Mounts}}{{.Type}}{{"\u001f"}}{{.Source}}{{"\u001f"}}{{.Destination}}{{"\n"}}{{end}}' \
    "$CONTAINER" 2>/dev/null || true
}

# 容器内真实路径：逐级向上找已存在的祖先做 realpath，再把不存在的尾部拼回去。
guest_realpaths() {
  docker exec -i -e "E2E_REALPATH_TARGETS=$1" "$CONTAINER" node -e '
const fs = require("fs")
const path = require("path")
const targets = String(process.env.E2E_REALPATH_TARGETS || "").split("\n").filter(Boolean)
function resolveTarget(target) {
  let current = target
  const rest = []
  for (;;) {
    try {
      const real = fs.realpathSync(current)
      return rest.length === 0 ? real : path.join(real, ...rest.reverse())
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return target
      rest.push(path.basename(current))
      current = parent
    }
  }
}
for (const target of targets) process.stdout.write(target + "\t" + resolveTarget(target) + "\n")
'
}

# 校验失败时把全部原因打印到 stdout 并返回 1；调用方负责 die（不会先写容器）。
verify_mount_isolation() {
  local host_home host_dsh table problems="" line mtype msrc mdst nsrc target resolved realpaths
  local sep=$'\x1f'
  host_home="$(norm_path "${HOME:-}")"
  host_dsh="$(norm_path "$host_home/.dsh")"
  table="$(mount_table)"

  while IFS="$sep" read -r mtype msrc mdst; do
    [ -n "$mdst" ] || continue
    case "$mdst" in
      /*) ;;
      *)
        problems="$problems
挂载目的地不是绝对路径：$mtype ${msrc:-<空>} → $mdst"
        continue ;;
    esac
    if [ "$mtype" != "tmpfs" ] && [ -n "$msrc" ]; then
      nsrc="$(norm_path "$msrc")"
      # 宿主 home 本身 / 它的祖先 / 宿主 ~/.dsh（及其子孙）一律拒绝。
      # 注意：宿主 home 下的**其它目录**（例如专门的 dsh-testbed-bpmn/）是
      # 测试台正常存储，不能一概拒绝；危险的是把 home 整体（或祖先）暴露。
      if path_within "$nsrc" "$host_home" || path_within "$nsrc" "$host_dsh" \
        || path_within "$host_dsh" "$nsrc"; then
        problems="$problems
挂载源暴露宿主 home / ~/.dsh：$mtype $msrc → $mdst（宿主 home=$host_home，~/.dsh=$host_dsh）"
      fi
    fi
    # 只认可测试台根目录 `/testbed` 这一条 bind 挂载（复审 R4）：
    #   - 根目录内部任何**嵌套 bind** 都不认可：即使目的地是
    #     `profiles/web/node_modules` / `dt/cache` 这种写入子目录，pnpm install
    #     也会直接写进另一份宿主存储；
    #   - 根目录之外的 bind 与写入路径做**双向**重叠判断（祖先或子孙都算重叠），
    #     不能再只判「目的地是写入根的祖先」。
    # volume / tmpfs 由容器自己管理，不指向宿主 home，不需要在这里拒绝。
    if [ "$mtype" = "bind" ] && [ "$mdst" != "$GUEST_ROOT" ]; then
      local guest_path
      if path_within "$GUEST_ROOT" "$mdst"; then
        problems="$problems
挂载目的地是测试台根内的嵌套 bind（只允许 $GUEST_ROOT 根挂载）：$mtype ${msrc:-<空>} → $mdst"
      else
        for guest_path in "$GUEST_HOME" "$GUEST_PROFILE" "$GUEST_PROFILE/node_modules" "$GUEST_LOG" "$GUEST_LOGS" "$GUEST_DT" "$GUEST_PREFIX"; do
          if path_within "$mdst" "$guest_path" || path_within "$guest_path" "$mdst"; then
            problems="$problems
挂载目的地与测试台写入路径双向重叠：$mtype ${msrc:-<空>} → $mdst（与 $guest_path 重叠）"
          fi
        done
      fi
    fi
  done <<< "$table"

  # 核对**实际写入叶路径**的解析结果，而不只是几个根目录：pnpm install 直接写
  # `profile/node_modules`，sed 写 `profile/package.json`，安装/启动写 `prefix/bin/dsh`。
  realpaths="$(guest_realpaths "$GUEST_HOME
$GUEST_PROFILE
$GUEST_PROFILE/package.json
$GUEST_PROFILE/node_modules
$GUEST_LOG
$GUEST_LOGS
$GUEST_DT
$GUEST_PREFIX
$GUEST_PREFIX/bin/dsh" 2>/dev/null || true)"
  if [ -z "$realpaths" ]; then
    problems="$problems
读不到容器 $CONTAINER 内测试台路径的真实路径（期望容器内有 node）"
  else
    while IFS=$'\t' read -r target resolved; do
      [ -n "$target" ] || continue
      if [ -z "$resolved" ]; then
        problems="$problems
读不到 $target 的真实路径"
        continue
      fi
      while IFS="$sep" read -r mtype msrc mdst; do
        [ -n "$mdst" ] || continue
        [ "$mtype" = "bind" ] || continue
        path_within "$mdst" "$resolved" || continue
        # 只有「测试台根目录的挂载 + 真实路径仍在 $GUEST_ROOT 下」是设计内的；
        # 符号链接把 profile 解析到别的 bind 挂载（例如宿主 home）必须拒绝。
        if path_within "$mdst" "$GUEST_ROOT" && path_within "$GUEST_ROOT" "$resolved"; then
          continue
        fi
        problems="$problems
写入路径的真实路径落在 bind 挂载下：$target → $resolved（挂载 $msrc → $mdst）"
      done <<< "$table"
    done <<< "$realpaths"
  fi

  if [ -n "$problems" ]; then
    printf '%s\n' "$problems"
    return 1
  fi
  return 0
}
# <<< e2e-bpmn:mount-check

HOST_HOME_DIR="$(norm_path "${HOME:-}")"
HOST_DSH_DIR="$(norm_path "$HOST_HOME_DIR/.dsh")"
MOUNT_REPORT="$(verify_mount_isolation)" \
  || die "挂载 / 写入路径校验失败（宿主 home=$HOST_HOME_DIR、~/.dsh=$HOST_DSH_DIR 不能被暴露；测试台写入路径必须是容器本地）：
$MOUNT_REPORT"
# 再按 inode 做一次最直接的确认：测试台 home 不能就是宿主 ~/.dsh。
if [ -d "$HOST_DSH_DIR" ]; then
  HOST_DSH_ID="$(stat -Lc '%d:%i' "$HOST_DSH_DIR" 2>/dev/null || true)"
  GUEST_HOME_ID="$(guest_path_id "$GUEST_HOME" || true)"
  [ -n "$GUEST_HOME_ID" ] \
    || die "容器 $CONTAINER 内读不到测试台数据目录 $GUEST_HOME 的 dev:inode（期望它是容器内独立目录）"
  [ "$HOST_DSH_ID" != "$GUEST_HOME_ID" ] \
    || die "测试台数据目录 $GUEST_HOME 就是宿主 $HOST_DSH_DIR（dev:inode=$GUEST_HOME_ID 相同）：拒绝在宿主 home 上跑测试"
  ok "挂载隔离：测试台 $GUEST_HOME（dev:inode=$GUEST_HOME_ID）不是宿主 $HOST_DSH_DIR（$HOST_DSH_ID）"
else
  ok "挂载隔离：宿主 $HOST_DSH_DIR 不存在，容器未挂载它（实际挂载：$(printf '%s' "$(mount_table)" | tr '\n' ' ')）"
fi

# 1d. 监听 3080 的进程：有 → 必须属于该容器且是测试台 dsh；没有 → bootstrap。
LISTENERS="$(guest_listeners || true)"
LISTENER_COUNT="$(printf '%s' "$LISTENERS" | jqr 'Array.isArray(j)?j.length:-1')"
case "$LISTENER_COUNT" in
  ''|-1)
    die "容器 $CONTAINER 内读不出 /proc 监听信息（期望读到监听 3080 的进程，实际：$(printf '%.300s' "$LISTENERS")）" ;;
  0)
    # 容器刚重启 / dsh 崩了 / 第一次跑：没有在跑实例，不 kill、也不拿旧日志 token 赌端口归属，
    # 由本脚本用一次性令牌起一个，再用它的日志 token 登录 303 证明端口归属（bootstrap）。
    say "容器 $CONTAINER 内没有监听 3080 的实例：走 bootstrap（不 kill 任何进程，由本脚本启动 dsh）"
    start_guest_dsh
    BOOTSTRAP=1
    LISTENERS="$(guest_listeners || true)" ;;
esac
verify_guest_dsh "$LISTENERS"
LISTENER_PIDS="$VERIFIED_PIDS"
if [ "$BOOTSTRAP" = "1" ]; then
  ok "bootstrap：容器内 dsh 已由本脚本启动，监听 3080 的 PID：$LISTENER_PIDS（身份已核对）"
else
  ok "容器内监听 3080 的进程：PID $LISTENER_PIDS（comm/cwd/cmdline 已核对属于本容器）"
fi

# 1e. 端口归属：用容器日志里的令牌登录，303 才能证明端口上的服务就是该容器这次启动的 dsh。
PRE_LOGIN_TOKEN="$(dex_sh "grep -o 'token=[A-Za-z0-9_-]*' $GUEST_LOG 2>/dev/null | tail -1 | cut -d= -f2" 2>/dev/null | tr -d '\r\n' || true)"
[ -n "$PRE_LOGIN_TOKEN" ] \
  || die "容器 $CONTAINER 的日志 $GUEST_LOG 里取不到登录令牌（期望本次启动的 dsh 写过 token=...；实际为空）"
rm -f "$PRE_JAR"
PRE_LOGIN_CODE="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -c "$PRE_JAR" "$ORIGIN/?token=$PRE_LOGIN_TOKEN")"
assert_eq "$PRE_LOGIN_CODE" "303" "端口归属错配：宿主端口 $PORT 上的服务不是容器 $CONTAINER 这次启动的 dsh（用该容器日志令牌登录）"
ok "端口归属对应：用容器日志令牌登录返回 303，$ORIGIN 就是容器 $CONTAINER 的 dsh"
# 从这里开始才允许读取 / 改动测试台（安装 profile / 杀进程都在后面）。
PREFLIGHT_OK=1

if [ "$PREFLIGHT_ONLY" = "1" ]; then
  say "E2E_PREFLIGHT_ONLY=1：前置身份校验通过，按请求在任何安装 / 杀进程之前退出"
  exit 0
fi

# 前置要求容器里有 git 与 pnpm。git 只在缺少时补装（容器内，不碰宿主）。
if ! dex_sh 'command -v git >/dev/null 2>&1'; then
  say "容器内缺少 git，尝试在容器内用 apt 安装（仅容器）"
  dex_sh 'export DEBIAN_FRONTEND=noninteractive; apt-get update >/testbed/logs/apt-git.log 2>&1 || true; apt-get install -y --no-install-recommends git >>/testbed/logs/apt-git.log 2>&1' \
    || { dex_sh "tail -20 $GUEST_LOGS/apt-git.log" || true; die "容器内安装 git 失败"; }
fi
GIT_VERSION="$(dex_sh 'git --version' | tr -d '\r\n')"
case "$GIT_VERSION" in git\ version*) ;; *) die "容器内 git 不可用：$GIT_VERSION" ;; esac
ok "$GIT_VERSION"
PNPM_VERSION="$(dex_sh 'pnpm --version' | tr -d '\r\n')"
[ -n "$PNPM_VERSION" ] || die "容器内 pnpm 不可用"
ok "pnpm $PNPM_VERSION"

say "2. 构建 + 校验 + 打包（仓库版本 $VERSION）"
: >"$EVID/build-pack.log"
( cd "$REPO" && npm run build && node scripts/verify-build.mjs && npm pack --pack-destination "$EVID" ) \
  >>"$EVID/build-pack.log" 2>&1 \
  || { tail -40 "$EVID/build-pack.log"; die "npm run build / verify-build / npm pack 失败"; }
TGZ="$EVID/feiyueve-dsh-flow-studio-$VERSION.tgz"
[ -f "$TGZ" ] || die "没打出 $TGZ"
TGZ_VERSION="$(tar -xOf "$TGZ" package/package.json | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).version')"
assert_eq "$TGZ_VERSION" "$VERSION" "tgz 版本与仓库 package.json 版本不一致"
ok "$(basename "$TGZ")，$(stat -c '%s' "$TGZ") 字节，版本 $TGZ_VERSION"

say "3. 安装进容器 profile（pnpm，非手工解包）"
# 写入前复核：从这里开始会 docker cp / sed / pnpm install。挂载与真实路径
# 必须仍然成立，绝不在 profile 可能指向宿主目录时动第一个字节（复审 N3）。
WRITE_RECHECK="$(verify_mount_isolation)" \
  || die "写入前挂载复核失败：profile / 日志 / 安装目录可能落到宿主，已拒绝 sed / pnpm install：
$WRITE_RECHECK"
ok "写入前复核：profile / 日志 / 安装目录的真实路径仍不在宿主挂载下"
TGZ_NAME="$(basename "$TGZ")"
docker cp "$TGZ" "$CONTAINER:$GUEST_DT/" >/dev/null
dex_sh "sed -i -E 's|\"@feiyueve/dsh-flow-studio\"[[:space:]]*:[[:space:]]*\"[^\"]*\"|\"@feiyueve/dsh-flow-studio\": \"file:$GUEST_DT/$TGZ_NAME\"|' $GUEST_PROFILE/package.json"
dex_sh "grep -q 'file:$GUEST_DT/$TGZ_NAME' $GUEST_PROFILE/package.json" \
  || die "sed 没把 profile 依赖改成 file:$GUEST_DT/$TGZ_NAME"
ok "profile 依赖已指向 file:$GUEST_DT/$TGZ_NAME"
: >"$EVID/pnpm-install.log"
dex_sh "cd $GUEST_PROFILE && PATH=$GUEST_PREFIX/bin:\$PATH pnpm install --no-frozen-lockfile" \
  >"$EVID/pnpm-install.log" 2>&1 \
  || { tail -30 "$EVID/pnpm-install.log"; die "pnpm install 失败"; }
INSTALLED_VERSION="$(dex_sh "node -p \"require('$GUEST_PROFILE/node_modules/@feiyueve/dsh-flow-studio/package.json').version\"" | tr -d '\r\n')"
assert_eq "$INSTALLED_VERSION" "$VERSION" "容器内 @feiyueve/dsh-flow-studio 版本不对"
# version 相同不足以证明装的是**这一份**构建：再比一次画布 chunk 的字节。
docker cp "$CONTAINER:$GUEST_PROFILE/node_modules/@feiyueve/dsh-flow-studio/lib/client.bpmn.js" \
  "$EVID/installed-client.bpmn.js" >/dev/null
cmp -s "$EVID/installed-client.bpmn.js" "$REPO/lib/client.bpmn.js" \
  || die "容器内 lib/client.bpmn.js 与仓库构建产物不一致（装的不是本轮构建）"
ok "容器内版本 $INSTALLED_VERSION，lib/client.bpmn.js 与仓库逐字节一致（$(stat -c '%s' "$REPO/lib/client.bpmn.js") 字节）"

say "4. 重启容器内 dsh（只终止本容器内监听 3080 的 dsh 进程）"
# review-0136 F6：不能按 comm 一把杀。先按 socket inode 找到监听 3080 的 PID，
# 再核对 comm / cwd / cmdline；任何一项不符就拒绝动手，避免杀掉容器里别的 node。
KILL_JSON="$(guest_listeners || true)"
verify_guest_dsh "$KILL_JSON"
KILL_PIDS="$VERIFIED_PIDS"
[ -n "$KILL_PIDS" ] || die "端口 $PORT 仍在监听，但容器 $CONTAINER 内找不到对应的 dsh 进程；拒绝盲杀"
for pid in $KILL_PIDS; do
  dex_sh "kill $pid 2>/dev/null || true"
done
ok "已终止容器内 dsh PID：$KILL_PIDS（仅限监听 3080 且 comm/cwd/cmdline 核对通过）"
# 等端口真正释放，避免新进程起在旧进程占用的 3080 上（那样冒烟看到的还是旧进程）。
OLD_GONE=0
for _ in $(seq 1 40); do
  CODE="$(curl -s -m 1 -o /dev/null -w '%{http_code}' "$ORIGIN/" 2>/dev/null || true)"
  [ "$CODE" = "000" ] && { OLD_GONE=1; break; }
  sleep 0.5
done
[ "$OLD_GONE" = "1" ] || die "旧 dsh 进程未释放端口 $PORT"
start_guest_dsh
# 重启后端口上的服务也必须是本容器内的 dsh（防止端口被别人先占用）。
NEW_LISTENERS="$(guest_listeners || true)"
verify_guest_dsh "$NEW_LISTENERS"
NEW_PIDS="$VERIFIED_PIDS"
ok "容器内 dsh 已重启（$ORIGIN/ 返回 $STARTED_HTTP_CODE，监听 3080 的 PID：$NEW_PIDS）"

say "5. 登录换 cookie"
LOGIN_TOKEN="$(dex_sh "grep -o 'token=[A-Za-z0-9_-]*' $GUEST_LOG 2>/dev/null | tail -1 | cut -d= -f2" 2>/dev/null | tr -d '\r\n' || true)"
[ -n "$LOGIN_TOKEN" ] || { dex_sh "tail -20 $GUEST_LOG" || true; die "没能从容器日志取到登录令牌"; }
rm -f "$JAR"
LOGIN_CODE="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -c "$JAR" "$ORIGIN/?token=$LOGIN_TOKEN")"
assert_eq "$LOGIN_CODE" "303" "登录换 cookie 失败（宿主登录令牌无效或进程还是旧的）"
ok "宿主登录 cookie 就位（303）"

say "6. 健康检查"
assert_code "$(get_api "/health" "$EVID/health.json")" "GET /health 失败" 200
assert_true "$(jqr 'j.ok===true' <"$EVID/health.json")" "/health 的 ok 不是 true"
assert_eq "$(jqr 'j.version' <"$EVID/health.json")" "$VERSION" "/health 的 version 与仓库版本不一致"
assert_true "$(jqr 'j.bpmn&&j.bpmn.enabled===true' <"$EVID/health.json")" "/health 的 bpmn.enabled 不是 true"
# authMode=full 证明请求确实带上了本轮设置的插件令牌，而不是落在 connection 档。
assert_eq "$(jqr 'j.authMode' <"$EVID/health.json")" "full" "/health 的 authMode 不是 full（FLOW_STUDIO_TOKEN 未生效）"
FLOW_DIR="$(jqr 'j.dir' <"$EVID/health.json")"
[ -n "$FLOW_DIR" ] || die "/health 没返回 dir，推不出 BPMN 数据根"
BPMN_BASE="$(dirname "$FLOW_DIR")"
ok "health: version=$VERSION ok=true bpmn.enabled=true authMode=full（数据根 $BPMN_BASE）"

say "7. 画布 chunk（client.bpmn.js）"
curl -s -m 15 -b "$JAR" "$ORIGIN/" -o "$EVID/index.html"
CHUNK_REV="$(node -e '
const fs = require("fs")
const html = fs.readFileSync(process.argv[1], "utf8")
let rev = null
// 宿主 0.2.2 起：HTML 的 __DSH_BOOT__ 里给的是入口 client.js 的 rev，
// 宿主协议要求 chunk URL 复用**入口 rev**（docs/plan/0.13-研究-bpmn-io.md §24）。
const direct = /client\.bpmn\.js[&?]rev=([0-9a-f]+)/.exec(html)
if (direct) {
  rev = direct[1]
} else {
  const match = /__DSH_BOOT__"\]\s*=\s*(\{[\s\S]*?\})\s*<\/script>/.exec(html)
  if (match) {
    const boot = JSON.parse(match[1])
    const entry = (boot.entries || []).find(item => item.id === "@feiyueve/dsh-flow-studio")
    if (entry) {
      const fromUrl = /[?&]rev=([0-9a-f]+)/.exec(entry.url || "")
      rev = fromUrl ? fromUrl[1] : (entry.rev || null)
    }
  }
}
if (!rev) process.exit(2)
process.stdout.write(rev)
' "$EVID/index.html")" || die "从 / 的 HTML 里取不到 client.bpmn.js 的 rev"
[ -n "$CHUNK_REV" ] || die "client.bpmn.js 的 rev 为空"
CHUNK_URL="$ORIGIN/plugins/@feiyueve/dsh-flow-studio/client.bpmn.js?rev=$CHUNK_REV"
CHUNK_CODE="$(curl -s -m 30 -b "$JAR" -o "$EVID/client.bpmn.js" -w '%{http_code}' "$CHUNK_URL")"
assert_eq "$CHUNK_CODE" "200" "GET client.bpmn.js?rev=$CHUNK_REV 失败"
# 宿主会在插件 JS 末尾追加 `;\n//# sourceMappingURL=...` 尾注（rev 会变，字节数随之 +60 左右）；
# 比较「去掉该尾注后的正文」与仓库 lib/client.bpmn.js，才能既验内容又验字节。
CHUNK_SIZES="$(node -e '
const fs = require("fs")
const served = fs.readFileSync(process.argv[1])
const local = fs.readFileSync(process.argv[2])
let body = served
const idx = served.indexOf(Buffer.from("//# sourceMappingURL="))
if (idx >= 0) {
  // 尾注形如：<正文>\n;\n//# sourceMappingURL=client.bpmn.js.map?rev=<hex>\n
  let end = idx
  if (end > 0 && served[end - 1] === 0x0a) end -= 1
  if (end > 0 && served[end - 1] === 0x3b) end -= 1 // 宿主追加的分号
  body = served.subarray(0, end)
}
if (!body.equals(local)) {
  console.error(`chunk 正文与仓库不一致：served=${served.length} stripped=${body.length} local=${local.length}`)
  process.exit(1)
}
if (!body.includes(Buffer.from("bpmn-js"))) {
  console.error("chunk 正文不含 bpmn-js")
  process.exit(1)
}
process.stdout.write(`served=${served.length} stripped=${body.length} local=${local.length}`)
' "$EVID/client.bpmn.js" "$REPO/lib/client.bpmn.js")" || die "client.bpmn.js 内容/字节与仓库不一致"
ok "rev=$CHUNK_REV，HTTP 200，$CHUNK_SIZES，含 bpmn-js"

say "8. 新域全链路（definitions → instances → 人工任务 → 完成）"
# 带 BPMN DI 的最小定义；元素 id 固定，便于按契约断言。
cat >"$EVID/definition.xml" <<'XML'
<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" id="defs-e2e-bpmn" targetNamespace="http://example.com/flow-studio">
  <bpmn:process id="e2e-bpmn-process" name="E2E 最小流程" isExecutable="true">
    <bpmn:startEvent id="e2e-start" name="开始"/>
    <bpmn:userTask id="e2e-user-task" name="人工确认"/>
    <bpmn:endEvent id="e2e-end" name="结束"/>
    <bpmn:sequenceFlow id="e2e-flow-start" sourceRef="e2e-start" targetRef="e2e-user-task"/>
    <bpmn:sequenceFlow id="e2e-flow-end" sourceRef="e2e-user-task" targetRef="e2e-end"/>
  </bpmn:process>
  <bpmndi:BPMNDiagram id="e2e-diagram">
    <bpmndi:BPMNPlane id="e2e-plane" bpmnElement="e2e-bpmn-process">
      <bpmndi:BPMNShape id="e2e-start-di" bpmnElement="e2e-start"><dc:Bounds x="120" y="120" width="36" height="36"/></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="e2e-user-task-di" bpmnElement="e2e-user-task"><dc:Bounds x="220" y="98" width="100" height="80"/></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="e2e-end-di" bpmnElement="e2e-end"><dc:Bounds x="380" y="120" width="36" height="36"/></bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="e2e-flow-start-di" bpmnElement="e2e-flow-start"><di:waypoint x="156" y="138"/><di:waypoint x="220" y="138"/></bpmndi:BPMNEdge>
      <bpmndi:BPMNEdge id="e2e-flow-end-di" bpmnElement="e2e-flow-end"><di:waypoint x="320" y="138"/><di:waypoint x="380" y="138"/></bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>
XML
node -e '
const fs = require("fs")
fs.writeFileSync(process.argv[2], JSON.stringify({
  id: process.argv[3],
  name: "E2E BPMN 最小流程",
  xml: fs.readFileSync(process.argv[1], "utf8"),
}))
' "$EVID/definition.xml" "$EVID/definition-body.json" "$DEF_ID"

SAVE_CODE="$(post_json "/definitions" "$EVID/definition-body.json" "$EVID/definition-save.json")"
assert_code "$SAVE_CODE" "POST /definitions 失败" 200 201
assert_eq "$(jqr 'j.id' <"$EVID/definition-save.json")" "$DEF_ID" "POST /definitions 返回的 id 不对"
DEF_VERSION="$(jqr 'j.version' <"$EVID/definition-save.json")"
[ -n "$DEF_VERSION" ] || die "POST /definitions 没返回 version"
ok "定义 $DEF_ID v$DEF_VERSION 已保存（HTTP $SAVE_CODE）"

assert_code "$(get_api "/definitions" "$EVID/definitions.json")" "GET /definitions 失败" 200
assert_true "$(jqr "j.definitions.some(d=>d.id==='$DEF_ID')" <"$EVID/definitions.json")" "定义列表里没有 $DEF_ID"
ok "GET /definitions 能列出 $DEF_ID"

assert_code "$(get_api "/definitions/$DEF_ID" "$EVID/definition.json")" "GET /definitions/$DEF_ID 失败" 200
assert_eq "$(jqr 'j.version' <"$EVID/definition.json")" "$DEF_VERSION" "定义详情 version 与保存时不一致"
node -e '
const fs = require("fs")
const detail = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
const submitted = fs.readFileSync(process.argv[2], "utf8")
if (detail.xml !== submitted) {
  console.error("定义详情的 xml 与提交内容不一致")
  process.exit(1)
}
' "$EVID/definition.json" "$EVID/definition.xml" || die "GET /definitions/$DEF_ID 未原样返回 xml"
ok "GET /definitions/$DEF_ID 返回 version=$DEF_VERSION 与原始 xml"

node -e '
const fs = require("fs")
fs.writeFileSync(process.argv[1], JSON.stringify({
  definitionId: process.argv[2],
  definitionVersion: Number(process.argv[3]),
  variables: {},
}))
' "$EVID/instance-body.json" "$DEF_ID" "$DEF_VERSION"
INSTANCE_CODE="$(post_json "/instances" "$EVID/instance-body.json" "$EVID/instance-start.json")"
assert_code "$INSTANCE_CODE" "POST /instances 失败" 200 201
IID="$(jqr 'j.id' <"$EVID/instance-start.json")"
[ -n "$IID" ] || die "POST /instances 没返回 instanceId"
ok "实例 $IID 已启动（HTTP $INSTANCE_CODE，status=$(jqr 'j.status' <"$EVID/instance-start.json")）"

PENDING=0
for _ in $(seq 1 60); do
  get_api "/instances/$IID" "$EVID/instance.json" >/dev/null
  if [ "$(jqr 'Array.isArray(j.pendingTasks)&&j.pendingTasks.length>0' <"$EVID/instance.json")" = "true" ]; then
    PENDING=1
    break
  fi
  sleep 0.5
done
[ "$PENDING" = "1" ] || die "30s 内实例 $IID 没有出现 pendingTasks"
assert_eq "$(jqr 'j.status' <"$EVID/instance.json")" "ACTIVE" "出现人工任务时实例不是 ACTIVE"
assert_eq "$(jqr 'j.pendingTasks[0].activityId' <"$EVID/instance.json")" "$ACTIVITY_ID" "pendingTasks 的 activityId 不是 $ACTIVITY_ID"
ok "实例停在人工任务：status=ACTIVE，pendingTasks[0].activityId=$ACTIVITY_ID"

node -e '
const fs = require("fs")
fs.writeFileSync(process.argv[1], JSON.stringify({
  payload: { approved: true },
  decidedBy: "e2e-bpmn",
}))
' "$EVID/complete-body.json"
COMPLETE_CODE="$(post_json "/instances/$IID/tasks/$ACTIVITY_ID/complete" "$EVID/complete-body.json" "$EVID/complete.json")"
assert_code "$COMPLETE_CODE" "POST /instances/$IID/tasks/$ACTIVITY_ID/complete 失败" 200
assert_eq "$(jqr 'j.status' <"$EVID/complete.json")" "COMPLETED" "完成人工任务后实例不是 COMPLETED"
ok "人工任务完成：HTTP 200，status=COMPLETED，decidedBy=$(jqr 'j.decidedBy' <"$EVID/complete.json")"

DONE=0
for _ in $(seq 1 60); do
  get_api "/instances/$IID" "$EVID/instance.json" >/dev/null
  if [ "$(jqr 'j.status' <"$EVID/instance.json")" = "COMPLETED" ]; then
    DONE=1
    break
  fi
  sleep 0.5
done
[ "$DONE" = "1" ] || die "实例 $IID 没有在 30s 内变成 COMPLETED"
ok "轮询到实例 status=COMPLETED"

assert_code "$(get_api "/instances/$IID/events?since=0" "$EVID/events.json")" "GET /instances/$IID/events?since=0 失败" 200
for event_type in activity/end process/end; do
  assert_true "$(jqr "j.events.some(e=>e.type==='$event_type')" <"$EVID/events.json")" "事件流里没有 $event_type"
done
ok "事件流含 activity/end 与 process/end（lastSeq=$(jqr 'j.lastSeq' <"$EVID/events.json")）"

assert_code "$(get_api "/instances/$IID/definition" "$EVID/instance-definition.json")" "GET /instances/$IID/definition 失败" 200
node -e '
const fs = require("fs")
const frozen = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
const submitted = fs.readFileSync(process.argv[2], "utf8")
if (frozen.xml !== submitted) {
  console.error("冻结快照与提交的 xml 不一致")
  process.exit(1)
}
if (frozen.definitionId !== process.argv[3]) {
  console.error(`冻结快照的 definitionId 不对：${frozen.definitionId}`)
  process.exit(1)
}
' "$EVID/instance-definition.json" "$EVID/definition.xml" "$DEF_ID" \
  || die "GET /instances/$IID/definition 未返回冻结 XML"
ok "GET /instances/$IID/definition 返回冻结 XML（definitionVersion=$(jqr 'j.definitionVersion' <"$EVID/instance-definition.json")）"

say "8b. 清理（当前新域没有 DELETE 路由：先断言 405，再清测试台数据目录）"
DEL_INSTANCE_CODE="$(del_code "/instances/$IID")"
assert_eq "$DEL_INSTANCE_CODE" "405" "DELETE /instances/$IID 竟然被路由接受（契约已变，请更新本脚本）"
DEL_DEF_CODE="$(del_code "/definitions/$DEF_ID")"
assert_eq "$DEL_DEF_CODE" "405" "DELETE /definitions/$DEF_ID 竟然被路由接受（契约已变，请更新本脚本）"
ok "确认新域无 HTTP DELETE（均 405）——清理走容器内测试台数据目录"
# 清理也是写操作：数据根的真实路径必须还在测试台 home 下，不能 rm 到挂载源。
BPMN_BASE_REAL="$(guest_realpaths "$BPMN_BASE" 2>/dev/null | cut -f2 || true)"
BPMN_BASE_REAL="${BPMN_BASE_REAL%$'\r'}"
case "$BPMN_BASE_REAL" in
  "$GUEST_HOME"/*) ;;
  *) die "BPMN 数据根 $BPMN_BASE 的真实路径 ${BPMN_BASE_REAL:-<空>} 不在测试台 $GUEST_HOME 下，拒绝 rm -rf" ;;
esac
dex_sh "rm -rf $BPMN_BASE/instances/$IID $BPMN_BASE/definitions/$DEF_ID"
assert_code "$(get_api "/instances?definitionId=$DEF_ID" "$EVID/instances-after-cleanup.json")" "清理后 GET /instances 失败" 200
assert_true "$(jqr "j.instances.every(i=>i.id!=='$IID')" <"$EVID/instances-after-cleanup.json")" "清理后实例列表里仍有 $IID"
assert_code "$(get_api "/definitions" "$EVID/definitions-after-cleanup.json")" "清理后 GET /definitions 失败" 200
assert_true "$(jqr "j.definitions.every(d=>d.id!=='$DEF_ID')" <"$EVID/definitions-after-cleanup.json")" "清理后定义列表里仍有 $DEF_ID"
ok "实例与定义都已从列表消失"

say "9. 鉴权回归"
NO_COOKIE_CODE="$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$BASE/instances")"
assert_code "$NO_COOKIE_CODE" "无 cookie 的 GET /instances 竟然放行" 401 403
ok "无 cookie 的 GET /instances 被拒：$NO_COOKIE_CODE"
BEARER_ONLY_CODE="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/instances")"
assert_code "$BEARER_ONLY_CODE" "只有插件令牌、无 cookie 的 GET /instances 竟然放行" 401 403
ok "只有插件令牌、无 cookie 也被拒：$BEARER_ONLY_CODE"
COOKIE_ONLY_CODE="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -b "$JAR" \
  -H 'content-type: application/json' -X POST \
  --data '{"id":"auth-deny","name":"deny","xml":"<not-bpmn/>"}' "$BASE/definitions")"
assert_code "$COOKIE_ONLY_CODE" "只有 cookie、无插件令牌的写请求竟然放行" 401 403
ok "只有 cookie、无插件令牌的 POST /definitions 被拒：$COOKIE_ONLY_CODE"

say "10. 宿主隔离回归（只读）"
HOST_DSH_ACTIVE_AFTER="$(systemctl is-active dsh-web 2>/dev/null || true)"
HOST_DSH_START_AFTER="$(systemctl show -p ActiveEnterTimestamp --value dsh-web 2>/dev/null || true)"
assert_eq "$HOST_DSH_ACTIVE_AFTER" "$HOST_DSH_ACTIVE_BEFORE" "宿主 dsh-web 的 active 状态变了"
assert_eq "$HOST_DSH_START_AFTER" "$HOST_DSH_START_BEFORE" "宿主 dsh-web 的 ActiveEnterTimestamp 变了"
ok "宿主 dsh-web 未被触碰：active=$HOST_DSH_ACTIVE_AFTER，ActiveEnterTimestamp 未变"

say "全部通过"
ok "BPMN 域容器验收通过（版本 $VERSION，容器 $CONTAINER）"
ok "本次证据：${EVID#"$REPO"/}（按运行隔离；其它运行的证据未被清理）"
