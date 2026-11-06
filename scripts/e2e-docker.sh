#!/usr/bin/env bash
# 运行日志 + 执行引擎的 Docker 端到端验收。
#
# 用法：
#   scripts/e2e-docker.sh            # 打包当前仓库 → 装进测试台容器 → 用桩引擎跑一次完整的 run → 断言
#   KEEP=1 scripts/e2e-docker.sh     # 失败时保留容器现场（默认失败也会打印取证）
#
# 依赖：已存在的测试台容器（默认 dsh-testbed-fs），宿主端口默认 3121。
# 说明：用 FLOW_STUDIO_STUB_ENGINE=1 起容器内 dsh —— 桩执行器不调模型，只验证
#       编排、事件、指标、打回、落盘这条链；真模型路径在真实 profile 里才是默认。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
CONTAINER="${TESTBED_CONTAINER:-dsh-testbed-fs}"
PORT="${TESTBED_PORT:-3121}"
GUEST_ROOT="${TESTBED_ROOT_IN_CONTAINER:-/testbed}"
GUEST_HOME="$GUEST_ROOT/home"
GUEST_PROFILE="$GUEST_HOME/profiles/web"
GUEST_PREFIX="$GUEST_ROOT/prefix"
BASE="http://127.0.0.1:$PORT/api/flow-studio"
# 鉴权：v1.1 起插件路由接回宿主鉴权，无凭据一律 401；测试台用 FLOW_STUDIO_TOKEN 走 Bearer。
TOKEN="${TESTBED_FS_TOKEN:-fs-$(openssl rand -hex 16 2>/dev/null || node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')}"
VERSION="$(node -p "require('$REPO/package.json').version")"
TGZ="$REPO/.tmp/feiyueve-dsh-flow-studio-$VERSION.tgz"
# 宿主登录 cookie（v1.1 起插件路由与 /api 同口径，光有插件令牌不够）。
JAR="$REPO/.tmp/e2e-cookies.txt"

say()  { printf '\033[1;34m==> \033[0m%s\n' "$*"; }
ok()   { printf '\033[1;32m OK \033[0m%s\n' "$*"; }
die()  { printf '\033[1;31m失败: \033[0m%s\n' "$*" >&2; exit 1; }
dex()  { docker exec -i "$CONTAINER" "$@"; }
# 容器内 sh（PATH 已含 guest prefix，DSH_HOME 指向测试台 home）
dex_sh() {
  local script="$1"; shift
  docker exec -i "$@" \
    -e "DSH_HOME=$GUEST_HOME" \
    -e PATH="$GUEST_PREFIX/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    "$CONTAINER" sh -c "$script"
}

# 带鉴权头的请求：宿主登录 cookie（第一道，与 /api 同口径）+ 插件令牌（第二道，Bearer）。
req() { curl -s -m 10 -b "$JAR" -H "Authorization: Bearer $TOKEN" "$@"; }
jqr() { node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String(eval(process.argv[1])))}catch(e){process.stdout.write("")}})' "$1"; }

cleanup() {
  local rc=$?
  if [ $rc -ne 0 ]; then
    say "失败取证（docker logs 尾部 + 最近的 run 目录）"
    docker logs --tail 60 "$CONTAINER" 2>&1 | tail -40 || true
    dex sh -c "ls -l $GUEST_HOME/flow-studio/runs 2>/dev/null | tail -5" || true
    [ "${KEEP:-0}" = "1" ] || true
  fi
}
trap cleanup EXIT

say "0. 前置检查"
docker inspect "$CONTAINER" >/dev/null 2>&1 || die "容器 $CONTAINER 不存在（先 scripts/testbed up）"
curl -s -m 5 -o /dev/null "http://127.0.0.1:$PORT/" || true
ok "容器 $CONTAINER 存在，宿主端口 $PORT"

say "1. 构建 + 打包 $VERSION"
(cd "$REPO" && npm run build >/dev/null && npm pack --pack-destination .tmp/ >/dev/null)
[ -f "$TGZ" ] || die "没打出 $TGZ"
ok "$(basename "$TGZ") $(stat -c '%s' "$TGZ") 字节"

say "2. 装进容器 profile（包管理器，不解包）"
docker cp "$TGZ" "$CONTAINER:$GUEST_ROOT/dt/" >/dev/null
dex sh -c "cd $GUEST_PROFILE && node -e '
const fs=require(\"fs\");const p=JSON.parse(fs.readFileSync(\"package.json\",\"utf8\"));
p.dependencies[\"@feiyueve/dsh-flow-studio\"]=\"file:$GUEST_ROOT/dt/$(basename "$TGZ")\";
if(!p.dsh.profile.bundles.includes(\"@feiyueve/dsh-flow-studio\"))p.dsh.profile.bundles.push(\"@feiyueve/dsh-flow-studio\");
fs.writeFileSync(\"package.json\",JSON.stringify(p,null,2));
'"
dex_sh "cd $GUEST_PROFILE && $GUEST_PREFIX/bin/pnpm install --no-frozen-lockfile" >"$REPO/.tmp/e2e-install.log" 2>&1 || { tail -20 "$REPO/.tmp/e2e-install.log"; die "pnpm install 失败"; }
INSTALLED="$(dex sh -c "node -p \"require('$GUEST_PROFILE/node_modules/@feiyueve/dsh-flow-studio/package.json').version\"" | tr -d '\r')"
[ "$INSTALLED" = "$VERSION" ] || die "容器内版本是 $INSTALLED，期望 $VERSION"
ok "容器内版本 $INSTALLED"

say "3. 用桩引擎重启容器内 dsh"
dex sh -c 'for p in /proc/[0-9]*; do n=$(cat "$p/comm" 2>/dev/null) || continue; \
  case "$n" in MainThread|node) kill "${p#/proc/}" 2>/dev/null ;; esac; done'
sleep 1
# FLOW_STUDIO_STUB_ENGINE=1：不调模型，桩按节点标题出 pass/reject
dex_sh "cd $GUEST_ROOT/workspace && setsid nohup dsh --profile web --port 3080 --no-open > $GUEST_ROOT/logs/dsh-web.log 2>&1 < /dev/null & echo started" \
  -e FLOW_STUDIO_TESTBED=1 -e FLOW_STUDIO_STUB_ENGINE=1 -e FLOW_STUDIO_TOKEN="$TOKEN" >/dev/null
for _ in $(seq 1 30); do
  dex_sh "grep -q '^dsh web: http' $GUEST_ROOT/logs/dsh-web.log" 2>/dev/null && break
  sleep 1
done
# 宿主鉴权：启动日志里打印一次性登录令牌，先换成这个进程签发的登录 cookie；
# Host 头必须与后续请求一致（这里都用 127.0.0.1:$PORT），否则 cookie 的 authority 对不上。
LOGIN_TOKEN="$(dex_sh "grep -o 'token=[A-Za-z0-9_-]*' $GUEST_ROOT/logs/dsh-web.log | head -1 | cut -d= -f2" 2>/dev/null | tr -d '\r\n')"
[ -n "$LOGIN_TOKEN" ] || die "没能从容器日志取到 dsh web 登录令牌"
rm -f "$JAR"
AUTH_CODE="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -c "$JAR" "http://127.0.0.1:$PORT/?token=$LOGIN_TOKEN" || true)"
[ "$AUTH_CODE" = "303" ] || die "登录换 cookie 失败（HTTP $AUTH_CODE）"
ok "宿主登录 cookie 就位（303）"
HEALTH="$(req "$BASE/health")"
# 无凭据必须被拒（v1.1 鉴权回归）：不带 cookie 也没有插件令牌
UNAUTH="$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$BASE/runs" || true)"
[ "$UNAUTH" = "401" ] || [ "$UNAUTH" = "403" ] || die "无凭据访问竟然返回 $UNAUTH（期望 401/403）"
ok "无凭据访问被拒：$UNAUTH"
# 只有宿主 cookie、没有插件令牌时，插件自己的第二道闸必须生效
NO_PLUGIN_TOKEN="$(curl -s -m 5 -o /dev/null -w '%{http_code}' -b "$JAR" "$BASE/runs" || true)"
[ "$NO_PLUGIN_TOKEN" = "401" ] || [ "$NO_PLUGIN_TOKEN" = "403" ] || die "缺插件令牌竟然返回 $NO_PLUGIN_TOKEN（期望 401/403）"
ok "缺插件令牌被拒：$NO_PLUGIN_TOKEN"
ENGINE="$(printf '%s' "$HEALTH" | jqr 'j.engine')"
[ "$ENGINE" = "stub" ] || die "health 里 engine=$ENGINE，期望 stub（health: $HEALTH）"
ok "health 就位：$(printf '%s' "$HEALTH" | jqr 'j.version+" / "+j.engine+" / "+j.auth')"

say "4. 建专用流程（带 skills + 一条打回边）并启动"
# 为什么要自建流程：出厂模板的节点没声明 skill，无法验证 skill 采纳率；这里造一条
# 需求分析(skill×2) → 测试(skill×1，打回需求分析) → 完成 的链，桩会首轮打回一次。
SKILL_A="$(req "$BASE/skills" | jqr '(j.skills&&j.skills[0]&&j.skills[0].name)||"java-service"')"
SKILL_B="$(req "$BASE/skills" | jqr '(j.skills&&j.skills[1]&&j.skills[1].name)||"code-review"')"
FLOW_BODY="$(node -e '
const [a,b] = process.argv.slice(1)
const node=(id,title,x,kind,skills)=>({id,title,kind:kind||"stage",x,y:220,mode:"single",role:title+"角色",task:title+"任务",skills:skills||[],outputs:title+"产物",maxRounds:2})
process.stdout.write(JSON.stringify({
  name:"docker e2e flow",
  nodes:[node("n_start","任务输入",80,"start",[]),node("n_a","需求分析",388,"stage",[a]),node("n_b","测试",696,"stage",[b]),node("n_end","完成",1004,"end",[])],
  edges:[
    {id:"e1",from:"n_start",to:"n_a",kind:"next"},
    {id:"e2",from:"n_a",to:"n_b",kind:"next"},
    {id:"e3",from:"n_b",to:"n_end",kind:"next"},
    {id:"e4",from:"n_b",to:"n_a",kind:"reject",label:"测试打回"}
  ]
}))' "$SKILL_A" "$SKILL_B")"
FLOW_JSON="$(req -X POST "$BASE/flows" -H 'content-type: application/json' -d "$FLOW_BODY")"
FLOW_ID="$(printf '%s' "$FLOW_JSON" | jqr 'j.flow.id')"
[ -n "$FLOW_ID" ] || die "建流程失败：$FLOW_JSON"
RUN_JSON="$(req -X POST "$BASE/runs" -H 'content-type: application/json' \
  -d "{\"flowId\":\"$FLOW_ID\",\"name\":\"docker e2e\"}")"
RUN_ID="$(printf '%s' "$RUN_JSON" | jqr 'j.run.id')"
[ -n "$RUN_ID" ] || die "建 run 失败：$RUN_JSON"
PENDING="$(printf '%s' "$RUN_JSON" | jqr 'j.run.status')"
[ "$PENDING" = "pending" ] || die "新建 run 状态是 $PENDING（期望 pending）"
ok "新建 run 为 pending"
req -X POST "$BASE/runs/$RUN_ID/start" -H 'content-type: application/json' -d '{}' >/dev/null || true
ok "run $RUN_ID 已启动（flow $FLOW_ID）"

say "5. 轮询到收口（最多 120s）"
STATUS=""
for _ in $(seq 1 60); do
  STATUS="$(req "$BASE/runs/$RUN_ID" | jqr 'j.run.status')"
  case "$STATUS" in done|failed|aborted) break ;; esac
  sleep 2
done
[ "$STATUS" = "done" ] || die "run 最终状态是 $STATUS（期望 done）"
SUMMARY="$(req "$BASE/runs/$RUN_ID/summary")"
EVENTS="$(req "$BASE/runs/$RUN_ID/events?limit=1000&order=asc")"
DETAIL="$(req "$BASE/runs/$RUN_ID")"
LIST="$(req "$BASE/runs?limit=10")"

say "6. 断言"
node - "$SUMMARY" "$EVENTS" "$STATUS" "$DETAIL" "$LIST" "$RUN_ID" <<'NODE'
const [summaryRaw, eventsRaw, status, detailRaw, listRaw, runId] = process.argv.slice(2)
const s = JSON.parse(summaryRaw).summary || JSON.parse(summaryRaw)
const detail = JSON.parse(detailRaw).run || {}
const ev = (JSON.parse(eventsRaw).events) || []
const kinds = ev.map(e => e.kind)
const fail = m => { console.error('断言失败: ' + m); process.exit(1) }
if (status !== 'done') fail('状态 ' + status)
if (!kinds.includes('run/start') || !kinds.includes('run/end')) fail('缺 run 边界事件')
if (!kinds.includes('node/start') || !kinds.includes('node/end')) fail('缺节点事件')
const rej = ev.filter(e => e.kind === 'reject/trigger')
if (rej.length < 1) fail('桩剧本应当至少有一次打回')
const attempts = new Set(ev.filter(e => e.kind === 'node/start').map(e => e.nodeId + '#' + e.attemptId))
if (![...attempts].some(a => a.endsWith('#2'))) fail('没有 attempt=2（重跑）')
const tok = s.tokens && s.tokens.total
if (!tok || !(tok.total > 0)) fail('token 合计没记上')
if (tok.total !== tok.input + tok.cacheRead + tok.cacheWrite + tok.output) fail('token 四桶合计不对')
if (!s.quality) fail('没有 quality')
if (s.engine !== 'stub') fail('summary 没标 engine=stub（桩数据必须可辨认）')
if (s.quality.state !== 'unknown') fail('桩 run 的 quality 必须是 unknown，实得 ' + s.quality.state)
if (!/桩/.test(s.quality.label || '')) fail('桩 run 的结论 label 没标「桩」：' + s.quality.label)
if (!(s.acceptance && s.acceptance.total > 0)) fail('acceptance 数字没算出来')
if (!s.progress || !(s.progress.ratio >= 0)) fail('没有 progress')
if (!s.skillUsage) fail('没有 skillUsage')
if (!(s.skillUsage.declaredCount >= 2)) fail('skill 声明数没记上（' + (s.skillUsage && s.skillUsage.declaredCount) + '）')
if (s.skillUsage.coverage !== 1) fail('skill 覆盖率应为 1（实得 ' + s.skillUsage.coverage + '）')
if (!s.findings) fail('没有 findings')
// B1 回归：progress 必须带每节点状态（只回计数会让客户端长跑时把已通过节点显示成未开始）
// 只有 stage 节点进执行计划（start/end 是标记节点），所以这里核 n_a / n_b 两个。
const pn = s.progress.nodes
if (!pn || typeof pn !== 'object') fail('summary.progress 缺 nodes')
for (const id of ['n_a', 'n_b']) {
  const entry = pn[id]
  if (!entry || typeof entry.status !== 'string' || !Number.isInteger(entry.attemptId)) {
    fail('progress.nodes 缺节点或字段不全：' + id + ' → ' + JSON.stringify(entry))
  }
}
if (!Array.isArray(s.progress.invalidatedNodes)) fail('缺 invalidatedNodes')
if (s.progress.total !== 2) fail('阶段总数应为 2（start/end 是标记节点），实得 ' + s.progress.total)
if (pn.n_b.attemptId !== 2) fail('n_b 当前 attempt 应为 2（打回后重跑），实得 ' + pn.n_b.attemptId)
if (pn.n_b.status !== 'passed') fail('n_b 最终应为 passed，实得 ' + pn.n_b.status)
if (!detail.progress || !detail.progress.nodes) fail('详情接口没带 progress.nodes')
if (detail.progress.nodes.n_b.attemptId !== 2) fail('详情接口的 progress.nodes 与 summary 不一致')
// 列表端点也必须带（05 §8.3「三个端点都带」，不只 summary / 详情）。
const list = JSON.parse(listRaw).runs || []
const row = list.find(item => item.id === runId)
if (!row) fail('列表里找不到刚跑完的 run')
if (!row.progress || !row.progress.nodes) fail('列表行缺 progress.nodes')
if (row.progress.nodes.n_b.attemptId !== 2) fail('列表行的 progress.nodes 与 summary 不一致')
console.log('  ✓ progress.nodes 就位（n_a/n_b attempt=2，total=2，invalidated=' + s.progress.invalidatedNodes.length + '）')
console.log('  ✓ 状态 done，事件 ' + ev.length + ' 条，打回 ' + rej.length + ' 次，attempt=' + [...attempts].filter(a => a.endsWith('#2')).length)
console.log('  ✓ token 合计 ' + tok.total + ' = ' + tok.input + '+' + tok.cacheRead + '+' + tok.cacheWrite + '+' + tok.output)
console.log('  ✓ quality=' + s.quality.state + ' · ' + (s.quality.label || ''))
console.log('  ✓ progress=' + s.progress.passed + '/' + s.progress.denominator + ' · skill 覆盖 ' + s.skillUsage.coverage)
NODE

say "7. 导出与落盘检查"
req "$BASE/runs/$RUN_ID/export" | head -3
dex sh -c "stat -c '%a %n' $GUEST_HOME/flow-studio/runs $GUEST_HOME/flow-studio/runs/$RUN_ID" || die "run 目录不存在"
ok "落盘正常"

say "8. 清理 run 与流程"
req -X DELETE "$BASE/runs/$RUN_ID" >/dev/null || true
req -X DELETE "$BASE/flows/$FLOW_ID" >/dev/null || true
ok "已删除 run $RUN_ID 与流程 $FLOW_ID"
echo
ok "Docker e2e 全部通过（版本 $VERSION，容器 $CONTAINER）"
