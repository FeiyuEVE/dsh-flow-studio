#!/usr/bin/env bash
# 新 BPMN 域（definitions / instances / 人工任务 / 画布 chunk）的容器测试台验收。
#
# 用法：
#   bash scripts/e2e-bpmn.sh          # 打包当前仓库 → 装进测试台容器 → 重启容器内 dsh → 只走 HTTP 跑完整链路
#   KEEP=1 bash scripts/e2e-bpmn.sh   # 失败时保留现场（默认也打印取证；KEEP 只影响是否清理旧证据）
#
# 环境变量覆盖：TESTBED_CONTAINER（默认 dsh-testbed-bpmn）、TESTBED_PORT（默认 3110）、KEEP。
#
# 边界：
#   - 只读宿主 dsh-web（systemctl is-active / ActiveEnterTimestamp），绝不重启、不碰宿主 ~/.dsh。
#   - 容器内测试台根 /testbed；所有临时产物落在仓库 .tmp/e2e-bpmn/（已 gitignore）。
#   - 安装必须走包管理器：拷 tgz → sed profile 依赖 → pnpm install，不手工解包。
#
# 为什么这里单独起一个 FLOW_STUDIO_TOKEN：
#   index.js 的鉴权是两层——宿主 connection 凭据（cookie）在前，插件令牌（Bearer）在后。
#   只有两层都配置，才能同时验到「无 cookie 被拒」与「有 cookie、无插件令牌的写请求被拒」。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
CONTAINER="${TESTBED_CONTAINER:-dsh-testbed-bpmn}"
PORT="${TESTBED_PORT:-3110}"
KEEP="${KEEP:-0}"

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
EVID="$REPO/.tmp/e2e-bpmn"
JAR="$EVID/cookies.txt"
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

on_exit() {
  local rc=$1
  if [ "$rc" -ne 0 ]; then
    printf '\n'
    say "失败取证（rc=$rc）：容器日志尾部 + 最近 HTTP 响应"
    docker exec -i "$CONTAINER" sh -c "tail -80 $GUEST_LOG 2>/dev/null" 2>/dev/null || true
    for f in "$EVID/last-response.json" "$EVID/definition-save.json" "$EVID/instance.json" "$EVID/events.json"; do
      [ -f "$f" ] || continue
      printf '\n--- %s ---\n' "${f#"$REPO"/}"
      head -c 4000 "$f" || true
      printf '\n'
    done
    printf '\n证据目录：%s（KEEP=%s；容器测试数据未清理）\n' "${EVID#"$REPO"/}" "$KEEP"
  fi
}
trap 'on_exit $?' EXIT

mkdir -p "$EVID"
if [ "$KEEP" != "1" ]; then
  # 只清本脚本自己的旧产物，不 rm 整个目录（外部 tee 的 run.log 等不该被误删）。
  rm -f "$EVID"/feiyueve-dsh-flow-studio-*.tgz \
        "$EVID"/health.json "$EVID"/index.html "$EVID"/client.bpmn.js \
        "$EVID"/installed-client.bpmn.js "$EVID"/definitions.json \
        "$EVID"/definition.json "$EVID"/definition-save.json \
        "$EVID"/definition.xml "$EVID"/definition-body.json \
        "$EVID"/instance-body.json "$EVID"/instance.json \
        "$EVID"/complete-body.json "$EVID"/complete.json \
        "$EVID"/events.json "$EVID"/instance-definition.json \
        "$EVID"/instances-after-cleanup.json "$EVID"/definitions-after-cleanup.json
fi

# 每次跑都用新的定义 id，避免上一轮残留把「新建」断言变成「更新」。
DEF_ID="e2e-bpmn-$(date +%s)-$$"
ACTIVITY_ID="e2e-user-task"

say "0. 宿主隔离基线（只读）"
HOST_DSH_ACTIVE_BEFORE="$(systemctl is-active dsh-web 2>/dev/null || true)"
HOST_DSH_START_BEFORE="$(systemctl show -p ActiveEnterTimestamp --value dsh-web 2>/dev/null || true)"
printf '    dsh-web active=%s ActiveEnterTimestamp=%s\n' "$HOST_DSH_ACTIVE_BEFORE" "$HOST_DSH_START_BEFORE"

say "1. 前置检查"
[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || true)" = "true" ] \
  || die "容器 $CONTAINER 不存在或未运行"
ok "容器 $CONTAINER 在运行"
curl -s -m 5 -o /dev/null "$ORIGIN/" || die "宿主端口 $PORT 不可达（$ORIGIN/）"
ok "宿主端口 $PORT 可达"

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

say "4. 重启容器内 dsh（按 /proc comm 精确杀 node / MainThread）"
# 只按 comm 匹配（等价 pkill -x）：sh -c 自身的命令行里也含启动命令，-f 会连自己一起杀；
# node 主线程名可能是 MainThread，只杀 node 会漏。
dex_sh 'for p in /proc/[0-9]*; do n=$(cat "$p/comm" 2>/dev/null) || continue; \
  case "$n" in MainThread|node) kill "${p#/proc/}" 2>/dev/null ;; esac; done'
# 等端口真正释放，避免新进程起在旧进程占用的 3080 上（那样冒烟看到的还是旧进程）。
OLD_GONE=0
for _ in $(seq 1 40); do
  CODE="$(curl -s -m 1 -o /dev/null -w '%{http_code}' "$ORIGIN/" 2>/dev/null || true)"
  [ "$CODE" = "000" ] && { OLD_GONE=1; break; }
  sleep 0.5
done
[ "$OLD_GONE" = "1" ] || die "旧 dsh 进程未释放端口 $PORT"
dex_sh "cd $GUEST_ROOT/workspace && setsid nohup node $GUEST_PREFIX/bin/dsh --profile web --port 3080 --no-open > $GUEST_LOG 2>&1 < /dev/null & echo started" \
  -e FLOW_STUDIO_TOKEN="$TOKEN" >/dev/null
READY=0
for _ in $(seq 1 80); do
  if dex_sh "grep -q '^dsh web: http' $GUEST_LOG" >/dev/null 2>&1; then READY=1; break; fi
  sleep 0.5
done
[ "$READY" = "1" ] || { dex_sh "tail -40 $GUEST_LOG" || true; die "容器内 dsh 未在 40s 内启动"; }
PORT_UP=0
for _ in $(seq 1 40); do
  CODE="$(curl -s -m 1 -o /dev/null -w '%{http_code}' "$ORIGIN/" 2>/dev/null || true)"
  [ "$CODE" != "000" ] && { PORT_UP=1; break; }
  sleep 0.5
done
[ "$PORT_UP" = "1" ] || die "容器内 dsh 启动后端口 $PORT 仍不可达"
ok "容器内 dsh 已重启（$ORIGIN/ 返回 $CODE）"

say "5. 登录换 cookie"
LOGIN_TOKEN="$(dex_sh "grep -o 'token=[A-Za-z0-9_-]*' $GUEST_LOG | head -1 | cut -d= -f2" | tr -d '\r\n')"
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

say "8b. 清理（0.13.4 的新域没有 DELETE 路由：先断言 405，再清测试台数据目录）"
DEL_INSTANCE_CODE="$(del_code "/instances/$IID")"
assert_eq "$DEL_INSTANCE_CODE" "405" "DELETE /instances/$IID 竟然被路由接受（契约已变，请更新本脚本）"
DEL_DEF_CODE="$(del_code "/definitions/$DEF_ID")"
assert_eq "$DEL_DEF_CODE" "405" "DELETE /definitions/$DEF_ID 竟然被路由接受（契约已变，请更新本脚本）"
ok "确认新域无 HTTP DELETE（均 405）——清理走容器内测试台数据目录"
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
