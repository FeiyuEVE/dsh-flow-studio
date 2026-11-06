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
# 宿主隔离回归的基线：只读 systemctl 状态与启动时间，绝不对宿主 dsh-web 做任何动作。
HOST_DSH_ACTIVE_BEFORE="$(systemctl is-active dsh-web 2>/dev/null || true)"
HOST_DSH_START_BEFORE="$(systemctl show -p ActiveEnterTimestamp --value dsh-web 2>/dev/null || true)"

# v0.7 T4 要求真 git：worktree 的创建/分支/目录都是 git 行为，没有 git 就验不了。
# 只在容器里装（宿主不动）；已有就跳过。
say "0b. 容器内 git（worktree 验收依赖）"
if ! dex sh -c 'command -v git >/dev/null 2>&1'; then
  say "容器内没有 git，安装到容器（仅容器）"
  dex sh -c 'export DEBIAN_FRONTEND=noninteractive; apt-get update >/testbed/logs/apt-git.log 2>&1 && apt-get install -y --no-install-recommends git >>/testbed/logs/apt-git.log 2>&1' \
    || { dex sh -c 'tail -20 /testbed/logs/apt-git.log' || true; die "容器内安装 git 失败"; }
fi
GIT_VERSION="$(dex sh -c 'git --version' | tr -d '\r')"
case "$GIT_VERSION" in git\ version*) ;; *) die "容器内 git 不可用：$GIT_VERSION" ;; esac
ok "$GIT_VERSION"

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

say "6b. v0.7 断言"
# ── 6b.1 版本 ────────────────────────────────────────────────────────────────
HEALTH_V="$(req "$BASE/health" | jqr 'j.version')"
[ -n "$VERSION" ] || die "读不到 package.json 版本"
# v0.7 起这段断言不写死版本号：用 package.json 的版本与 health 对账，升版本不用改脚本。

[ "$HEALTH_V" = "$VERSION" ] || die "health.version=$HEALTH_V（期望 $VERSION）"
ok "health.version = $HEALTH_V（与 package.json 一致）"

# ── 6b.2 并发不设上限 ────────────────────────────────────────────────────────
# 桩节点是毫秒级的；用一条 55 阶段的长链把 run 拉长，让「两个 run 同时 running」
# 在轮询窗口里真的能被观察到（短流程会在两次 start 之间就跑完，断言会假绿）。
LONG_FLOW_BODY="$(node - <<'NODE'
const count = 55
const nodes = [{ id: 'n_start', title: '任务输入', kind: 'start', x: 80, y: 220, mode: 'single', role: '', task: '', skills: [], outputs: '', maxRounds: 2 }]
for (let i = 0; i < count; i += 1) {
  nodes.push({ id: `s${i}`, title: `阶段${i + 1}`, kind: 'stage', x: 300 + i * 12, y: 220, mode: 'single', role: `阶段${i + 1}角色`, task: `阶段${i + 1}任务`, skills: [], outputs: `阶段${i + 1}产物`, maxRounds: 2 })
}
nodes.push({ id: 'n_end', title: '完成', kind: 'end', x: 300 + count * 12, y: 220, mode: 'single', role: '', task: '', skills: [], outputs: '', maxRounds: 2 })
const edges = [{ id: 'e_start', from: 'n_start', to: 's0', kind: 'next' }]
for (let i = 1; i < count; i += 1) edges.push({ id: `e${i}`, from: `s${i - 1}`, to: `s${i}`, kind: 'next' })
edges.push({ id: 'e_end', from: `s${count - 1}`, to: 'n_end', kind: 'next' })
process.stdout.write(JSON.stringify({ name: 'docker e2e long flow', nodes, edges }))
NODE
)"
LONG_FLOW_JSON="$(req -X POST "$BASE/flows" -H 'content-type: application/json' -d "$LONG_FLOW_BODY")"
LONG_FLOW_ID="$(printf '%s' "$LONG_FLOW_JSON" | jqr 'j.flow.id')"
[ -n "$LONG_FLOW_ID" ] || die "建长流程失败：$LONG_FLOW_JSON"
ok "并发用长流程 $LONG_FLOW_ID（55 阶段）"

CONC_A_JSON="$(req -X POST "$BASE/runs" -H 'content-type: application/json' -d "{\"flowId\":\"$LONG_FLOW_ID\",\"name\":\"concurrent A\"}")"
CONC_A_ID="$(printf '%s' "$CONC_A_JSON" | jqr 'j.run.id')"
CONC_B_JSON="$(req -X POST "$BASE/runs" -H 'content-type: application/json' -d "{\"flowId\":\"$LONG_FLOW_ID\",\"name\":\"concurrent B\"}")"
CONC_B_ID="$(printf '%s' "$CONC_B_JSON" | jqr 'j.run.id')"
[ -n "$CONC_A_ID" ] && [ -n "$CONC_B_ID" ] || die "建并发 run 失败：$CONC_A_JSON / $CONC_B_JSON"
# 先起轮询（含 node 启动开销），再并行发两个 start —— 保证并发窗口不被脚本自身吃掉。
cat >"$REPO/.tmp/e2e-concurrency.mjs" <<'NODE'
import { readFileSync } from 'node:fs'

const [base, token, jar, aId, bId] = process.argv.slice(2)
function cookieHeader(path) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/)
  const parts = []
  for (const line of lines) {
    if (!line || line.startsWith('# ') || line.startsWith('#\t')) continue
    const body = line.startsWith('#HttpOnly_') ? line.slice('#HttpOnly_'.length) : line
    if (body.startsWith('#')) continue
    const f = body.split('\t')
    if (f.length >= 7) parts.push(`${f[5]}=${f[6]}`)
  }
  return parts.join('; ')
}
const headers = { authorization: `Bearer ${token}`, cookie: cookieHeader(jar) }
const terminal = s => s === 'done' || s === 'failed' || s === 'aborted'
async function status(id) {
  const res = await fetch(`${base}/runs/${id}`, { headers, signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`GET /runs/${id} → HTTP ${res.status}`)
  const body = await res.json()
  return body.run && body.run.status
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const deadline = Date.now() + 60000
let a = 'pending'
let b = 'pending'
const trace = []
let bothRunning = false
while (Date.now() < deadline) {
  try {
    ;[a, b] = await Promise.all([status(aId), status(bId)])
  } catch (error) {
    // 容器内 dsh 刚好在做快照落盘 / 短连接抖动：不当作断言失败，继续轮询。
    await sleep(20)
    continue
  }
  const snap = `${a}/${b}`
  if (trace[trace.length - 1] !== snap) trace.push(snap)
  if (a === 'running' && b === 'running') { bothRunning = true; break }
  if (terminal(a) && terminal(b)) break
  await sleep(5)
}
if (!bothRunning) {
  console.error('没抓到「两个 run 同时 running」；状态轨迹：' + trace.join(' → '))
  process.exit(1)
}
console.log('✓ 抓到两个 run 同时 running（轨迹 ' + trace.join(' → ') + '）')
console.log(`  同时 running 快照 @${new Date().toISOString()}：${aId}=${a} · ${bId}=${b}`)
let finalA = a
let finalB = b
while (Date.now() < deadline) {
  ;[finalA, finalB] = await Promise.all([status(aId), status(bId)])
  if (terminal(finalA) && terminal(finalB)) break
  await sleep(100)
}
if (finalA !== 'done' || finalB !== 'done') {
  console.error(`并发 run 收尾状态 A=${finalA} B=${finalB}（期望都 done）`)
  process.exit(1)
}
console.log(`  收尾快照 @${new Date().toISOString()}：${aId}=${finalA} · ${bId}=${finalB}`)
console.log(`✓ 两个并发 run 都收口：A=${finalA} B=${finalB}`)
NODE
node "$REPO/.tmp/e2e-concurrency.mjs" "$BASE" "$TOKEN" "$JAR" "$CONC_A_ID" "$CONC_B_ID" >"$REPO/.tmp/e2e-concurrency.log" 2>&1 &
CONC_POLL_PID=$!
(req -o "$REPO/.tmp/e2e-conc-a-start.json" -w '%{http_code}' \
  -X POST "$BASE/runs/$CONC_A_ID/start" -H 'content-type: application/json' -d '{}' \
  >"$REPO/.tmp/e2e-conc-a-code.txt" 2>/dev/null) &
CONC_PID_A=$!
(req -o "$REPO/.tmp/e2e-conc-b-start.json" -w '%{http_code}' \
  -X POST "$BASE/runs/$CONC_B_ID/start" -H 'content-type: application/json' -d '{}' \
  >"$REPO/.tmp/e2e-conc-b-code.txt" 2>/dev/null) &
CONC_PID_B=$!
wait "$CONC_PID_A" "$CONC_PID_B"
CONC_A_CODE="$(cat "$REPO/.tmp/e2e-conc-a-code.txt")"
CONC_B_CODE="$(cat "$REPO/.tmp/e2e-conc-b-code.txt")"
case "$CONC_A_CODE" in 200|202) ;; *) die "并发 run A start 返回 $CONC_A_CODE（期望 200/202）：$(cat "$REPO/.tmp/e2e-conc-a-start.json")" ;; esac
case "$CONC_B_CODE" in 200|202) ;; *) die "并发 run B start 返回 $CONC_B_CODE（期望 200/202）：$(cat "$REPO/.tmp/e2e-conc-b-start.json")" ;; esac
ok "同一流程的两个 run 都启动成功（A=$CONC_A_CODE B=$CONC_B_CODE，无 409）"
if ! wait "$CONC_POLL_PID"; then
  cat "$REPO/.tmp/e2e-concurrency.log"
  die "并发断言失败（详见上方轮询日志）"
fi
sed 's/^/  /' "$REPO/.tmp/e2e-concurrency.log"

# ── 6b.3 supervision（放在 pending run 上做，避免和毫秒级 run 抢窗口）──────────
SUP_RUN_JSON="$(req -X POST "$BASE/runs" -H 'content-type: application/json' -d "{\"flowId\":\"$FLOW_ID\",\"name\":\"supervision probe\"}")"
SUP_RUN_ID="$(printf '%s' "$SUP_RUN_JSON" | jqr 'j.run.id')"
[ -n "$SUP_RUN_ID" ] || die "建 supervision 探针 run 失败：$SUP_RUN_JSON"
SUP_ON_CODE="$(req -o "$REPO/.tmp/e2e-sup-on.json" -w '%{http_code}' \
  -X POST "$BASE/runs/$SUP_RUN_ID/supervision" -H 'content-type: application/json' -d '{"enabled":true}')"
[ "$SUP_ON_CODE" = "200" ] || die "supervision enable 返回 $SUP_ON_CODE（期望 200）：$(cat "$REPO/.tmp/e2e-sup-on.json")"
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(!(j.supervision&&j.supervision.enabled===true)){console.error("enable 响应没带 enabled=true："+JSON.stringify(j));process.exit(1)}' "$REPO/.tmp/e2e-sup-on.json"
SUP_META_ON="$(dex sh -c "cat $GUEST_HOME/flow-studio/runs/$SUP_RUN_ID/run.json" | tr -d '\r')"
node -e 'const m=JSON.parse(process.argv[1]);if(!(m.supervision&&m.supervision.enabled===true)){console.error("run.json 没写 supervision.enabled=true："+JSON.stringify(m.supervision));process.exit(1)}' "$SUP_META_ON"
ok "supervision enable → 200，run.json.supervision.enabled=true"
SUP_OFF_CODE="$(req -o "$REPO/.tmp/e2e-sup-off.json" -w '%{http_code}' \
  -X POST "$BASE/runs/$SUP_RUN_ID/supervision" -H 'content-type: application/json' -d '{"enabled":false}')"
[ "$SUP_OFF_CODE" = "200" ] || die "supervision disable 返回 $SUP_OFF_CODE（期望 200）：$(cat "$REPO/.tmp/e2e-sup-off.json")"
SUP_META_OFF="$(dex sh -c "cat $GUEST_HOME/flow-studio/runs/$SUP_RUN_ID/run.json" | tr -d '\r')"
node -e 'const m=JSON.parse(process.argv[1]);if(!(m.supervision&&m.supervision.enabled===false&&typeof m.supervision.reason==="string"&&m.supervision.reason!=="")){console.error("run.json disable 结果不对："+JSON.stringify(m.supervision));process.exit(1)}' "$SUP_META_OFF"
ok "supervision disable → 200，enabled=false，reason=$(printf '%s' "$SUP_META_OFF" | jqr 'j.supervision.reason')"
SUP_404_CODE="$(req -o "$REPO/.tmp/e2e-sup-404.json" -w '%{http_code}' \
  -X POST "$BASE/runs/definitely-not-a-run/supervision" -H 'content-type: application/json' -d '{"enabled":true}')"
[ "$SUP_404_CODE" = "404" ] || die "不存在的 run 开 supervision 返回 $SUP_404_CODE（期望 404）"
ok "不存在的 run → 404"
SUP_DONE_CODE="$(req -o "$REPO/.tmp/e2e-sup-done.json" -w '%{http_code}' \
  -X POST "$BASE/runs/$RUN_ID/supervision" -H 'content-type: application/json' -d '{"enabled":true}')"
[ "$SUP_DONE_CODE" = "400" ] || die "已收尾 run 开 supervision 返回 $SUP_DONE_CODE（期望 400）：$(cat "$REPO/.tmp/e2e-sup-done.json")"
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const t=String(j.error||"");if(!/已结束|supervision/.test(t)){console.error("400 文案不可读："+t);process.exit(1)}' "$REPO/.tmp/e2e-sup-done.json"
ok "已收尾 run → 400（$(printf '%s' "$(cat "$REPO/.tmp/e2e-sup-done.json")" | jqr 'j.error')）"

# ── 6b.4 工作区 + 真 git worktree + sessionMode ───────────────────────────────
dex_sh "rm -rf /testbed/e2e-repo && mkdir -p /testbed/e2e-repo && git -C /testbed/e2e-repo init -q && printf 'hello e2e\n' > /testbed/e2e-repo/README.md && git -C /testbed/e2e-repo add README.md && git -C /testbed/e2e-repo -c user.name=e2e -c user.email=e2e@example.com commit -q -m init" \
  || die "容器内造 git 仓库 /testbed/e2e-repo 失败"
WT_RUN_JSON="$(req -X POST "$BASE/runs" -H 'content-type: application/json' \
  -d "{\"flowId\":\"$FLOW_ID\",\"name\":\"worktree auto\",\"workspace\":\"/testbed/e2e-repo\",\"worktree\":\"auto\"}")"
WT_ID="$(printf '%s' "$WT_RUN_JSON" | jqr 'j.run.id')"
[ -n "$WT_ID" ] || die "建 worktree run 失败：$WT_RUN_JSON"
WT_START_CODE="$(req -o "$REPO/.tmp/e2e-wt-start.json" -w '%{http_code}' \
  -X POST "$BASE/runs/$WT_ID/start" -H 'content-type: application/json' -d '{}')"
case "$WT_START_CODE" in 200|202) ;; *) die "worktree run start 返回 $WT_START_CODE：$(cat "$REPO/.tmp/e2e-wt-start.json")" ;; esac
WT_STATUS=""
for _ in $(seq 1 100); do
  WT_STATUS="$(req "$BASE/runs/$WT_ID" | jqr 'j.run.status')"
  case "$WT_STATUS" in done|failed|aborted) break ;; esac
  sleep 0.2
done
[ "$WT_STATUS" = "done" ] || die "worktree run 最终状态是 $WT_STATUS（期望 done）"
WT_DETAIL="$(req "$BASE/runs/$WT_ID")"
WT_META="$(dex sh -c "cat $GUEST_HOME/flow-studio/runs/$WT_ID/run.json" | tr -d '\r')"
WS_ID="$(printf '%s' "$WT_DETAIL" | jqr 'j.run.workspace.id')"
WT_PATH="$(printf '%s' "$WT_META" | jqr 'j.worktree.path')"
WT_BRANCH="$(printf '%s' "$WT_META" | jqr 'j.worktree.branch')"
[ -n "$WS_ID" ] || die "详情里 workspace.id 为空：$WT_DETAIL"
[ -n "$WT_PATH" ] || die "run.json 里 worktree.path 为空：$WT_META"
node - "$WT_DETAIL" "$WT_META" "$WT_ID" <<'NODE'
const [detailRaw, metaRaw, runId] = process.argv.slice(2)
const detail = JSON.parse(detailRaw).run || {}
const meta = JSON.parse(metaRaw)
const fail = m => { console.error('断言失败: ' + m); process.exit(1) }
if (!detail.workspace || !/^[0-9a-f]{12}$/.test(String(detail.workspace.id || ''))) fail('workspace.id 不是 12 位 hex：' + JSON.stringify(detail.workspace))
if (detail.workspace.path !== '/testbed/e2e-repo') fail('workspace.path=' + detail.workspace.path)
if (detail.workspace.isGit !== true) fail('workspace.isGit 应为 true')
if (!meta.worktree || meta.worktree.enabled !== true) fail('run.json worktree 未启用：' + JSON.stringify(meta.worktree))
if (meta.worktree.reason !== 'git-workspace') fail('worktree.reason=' + meta.worktree.reason)
if (meta.worktree.branch !== 'flow/' + runId) fail('branch=' + meta.worktree.branch + '（期望 flow/' + runId + '）')
const expected = `/testbed/home/flow-studio/worktrees/${detail.workspace.id}/${runId}`
if (meta.worktree.path !== expected) fail('worktree.path=' + meta.worktree.path + '（期望 ' + expected + '）')
if (meta.sessionMode !== 'stub') fail('run.json.sessionMode=' + meta.sessionMode + '（桩引擎下期望 stub）')
if (detail.sessionMode !== 'stub') fail('详情 sessionMode=' + detail.sessionMode + '（期望 stub）')
console.log('  ✓ workspace.id=' + detail.workspace.id + ' · path=' + detail.workspace.path)
console.log('  ✓ worktree.enabled=true · branch=' + meta.worktree.branch)
console.log('  ✓ worktree.path=' + meta.worktree.path)
console.log('  ✓ sessionMode=stub（run.json 与详情一致）')
NODE
[ "$WT_BRANCH" = "flow/$WT_ID" ] || die "worktree.branch=$WT_BRANCH（期望 flow/$WT_ID）"
WT_EXISTS="$(dex sh -c "test -d '$WT_PATH' && echo yes || echo no" | tr -d '\r')"
[ "$WT_EXISTS" = "yes" ] || die "worktree 目录不存在：$WT_PATH"
WT_HEAD="$(dex_sh "git -C '$WT_PATH' rev-parse --abbrev-ref HEAD" | tr -d '\r')"
[ "$WT_HEAD" = "flow/$WT_ID" ] || die "worktree HEAD 分支是 $WT_HEAD（期望 flow/$WT_ID）"
WT_TOP="$(dex_sh "git -C '$WT_PATH' rev-parse --show-toplevel" | tr -d '\r')"
[ "$WT_TOP" = "$WT_PATH" ] || die "worktree 的 git 根是 $WT_TOP（期望 $WT_PATH）"
[ "$(dex sh -c "test -f '$WT_PATH/README.md' && echo yes || echo no" | tr -d '\r')" = "yes" ] || die "worktree 里没有仓库内容 README.md"
ok "worktree 目录真实存在且是仓库内容（HEAD=$WT_HEAD）"

# on + 非 git 根 → 400，且文案可读
BAD_WT_JSON="$(req -X POST "$BASE/runs" -H 'content-type: application/json' \
  -d "{\"flowId\":\"$FLOW_ID\",\"name\":\"worktree on non-git\",\"workspace\":\"/testbed\",\"worktree\":\"on\"}")"
BAD_WT_ID="$(printf '%s' "$BAD_WT_JSON" | jqr 'j.run.id')"
[ -n "$BAD_WT_ID" ] || die "建 on/非 git 探针 run 失败：$BAD_WT_JSON"
BAD_WT_CODE="$(req -o "$REPO/.tmp/e2e-wt-bad.json" -w '%{http_code}' \
  -X POST "$BASE/runs/$BAD_WT_ID/start" -H 'content-type: application/json' -d '{}')"
[ "$BAD_WT_CODE" = "400" ] || die "worktree=on + /testbed 返回 $BAD_WT_CODE（期望 400）：$(cat "$REPO/.tmp/e2e-wt-bad.json")"
BAD_WT_ERROR="$(cat "$REPO/.tmp/e2e-wt-bad.json" | jqr 'j.error')"
case "$BAD_WT_ERROR" in *仓库根*|*git*|*worktree*) ;; *) die "400 文案不可读：$BAD_WT_ERROR" ;; esac
ok "worktree=on + 非 git 根 → 400（$BAD_WT_ERROR）"

# ?workspaceId= 只返回该工作区
FILTER_JSON="$(req "$BASE/runs?workspaceId=$WS_ID&limit=100")"
node - "$FILTER_JSON" "$WS_ID" "$WT_ID" <<'NODE'
const [raw, wsId, runId] = process.argv.slice(2)
const rows = JSON.parse(raw).runs || []
const fail = m => { console.error('断言失败: ' + m); process.exit(1) }
if (rows.length < 1) fail('?workspaceId= 返回空表')
const foreign = rows.filter(row => row.workspaceId !== wsId)
if (foreign.length > 0) fail('混进了别的 workspace：' + foreign.map(row => row.id + ':' + row.workspaceId).join(', '))
if (!rows.some(row => row.id === runId)) fail('过滤结果里没有刚建的 worktree run')
console.log('  ✓ ?workspaceId=' + wsId + ' 命中 ' + rows.length + ' 条，全部属于该工作区')
NODE
EMPTY_WS_JSON="$(req "$BASE/runs?workspaceId=000000000000&limit=100")"
[ "$(printf '%s' "$EMPTY_WS_JSON" | jqr '(j.runs||[]).length')" = "0" ] || die "未知 workspaceId 竟然返回了 run：$EMPTY_WS_JSON"
ok "未知 workspaceId → 空表"

# ── 6b.5 保存门禁（0.7 口径：保存 200 + validation.errors；启动 400）────────────
INVALID_FLOW_BODY="$(node - <<'NODE'
const nodes = [
  { id: 'n_start', title: '任务输入', kind: 'start', x: 80, y: 220, mode: 'single', role: '', task: '', skills: [], outputs: '', maxRounds: 2 },
  { id: 'n_bad', title: '自定义节点', kind: 'stage', x: 388, y: 220, mode: 'single', role: '开发角色', task: '调用外部命令', skills: [], outputs: '产物', maxRounds: 2, executor: 'custom', executorCommand: '' },
  { id: 'n_end', title: '完成', kind: 'end', x: 696, y: 220, mode: 'single', role: '', task: '', skills: [], outputs: '', maxRounds: 2 },
]
process.stdout.write(JSON.stringify({ name: 'docker e2e invalid executor', nodes, edges: [{ id: 'e1', from: 'n_start', to: 'n_bad', kind: 'next' }, { id: 'e2', from: 'n_bad', to: 'n_end', kind: 'next' }] }))
NODE
)"
INVALID_SAVE_CODE="$(req -o "$REPO/.tmp/e2e-invalid-flow.json" -w '%{http_code}' \
  -X POST "$BASE/flows" -H 'content-type: application/json' -d "$INVALID_FLOW_BODY")"
[ "$INVALID_SAVE_CODE" = "200" ] || die "保存 custom/缺 executorCommand 的流程返回 $INVALID_SAVE_CODE（0.7 口径应为 200）"
INVALID_FLOW_ID="$(cat "$REPO/.tmp/e2e-invalid-flow.json" | jqr 'j.flow.id')"
[ -n "$INVALID_FLOW_ID" ] || die "非法流程没返回 flow.id：$(cat "$REPO/.tmp/e2e-invalid-flow.json")"
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const e=(j.validation&&j.validation.errors)||[];if(!e.some(x=>/executorCommand/.test(String(x.message||"")))){console.error("validation.errors 里没有 executorCommand："+JSON.stringify(e));process.exit(1)}' "$REPO/.tmp/e2e-invalid-flow.json"
ok "保存 custom/缺 executorCommand → 200，validation.errors 命中 executorCommand"

CODEX_TEAM_BODY="$(node - <<'NODE'
const nodes = [
  { id: 'n_start', title: '任务输入', kind: 'start', x: 80, y: 220, mode: 'single', role: '', task: '', skills: [], outputs: '', maxRounds: 2 },
  { id: 'n_bad', title: '外部团队节点', kind: 'stage', x: 388, y: 220, mode: 'team', role: '主管角色', task: '外部执行', skills: [], outputs: '产物', maxRounds: 2, executor: 'codex', team: [{ name: '子 agent', role: '子角色', task: '子任务' }] },
  { id: 'n_end', title: '完成', kind: 'end', x: 696, y: 220, mode: 'single', role: '', task: '', skills: [], outputs: '', maxRounds: 2 },
]
process.stdout.write(JSON.stringify({ name: 'docker e2e codex team', nodes, edges: [{ id: 'e1', from: 'n_start', to: 'n_bad', kind: 'next' }, { id: 'e2', from: 'n_bad', to: 'n_end', kind: 'next' }] }))
NODE
)"
CODEX_SAVE_CODE="$(req -o "$REPO/.tmp/e2e-codex-team.json" -w '%{http_code}' \
  -X POST "$BASE/flows" -H 'content-type: application/json' -d "$CODEX_TEAM_BODY")"
[ "$CODEX_SAVE_CODE" = "200" ] || die "保存 codex+team 返回 $CODEX_SAVE_CODE（0.7 口径应为 200）"
CODEX_FLOW_ID="$(cat "$REPO/.tmp/e2e-codex-team.json" | jqr 'j.flow.id')"
[ -n "$CODEX_FLOW_ID" ] || die "codex+team 流程没返回 flow.id：$(cat "$REPO/.tmp/e2e-codex-team.json")"
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const e=(j.validation&&j.validation.errors)||[];if(e.length===0){console.error("codex+team 的 validation.errors 为空");process.exit(1)}if(!e.some(x=>/外部 executor|team/.test(String(x.message||"")))){console.error("没有 executor/team 规则错误："+JSON.stringify(e));process.exit(1)}' "$REPO/.tmp/e2e-codex-team.json"
ok "保存 codex+team → 200，validation.errors 非空（外部 executor/team 规则）"

INV_RUN_JSON="$(req -X POST "$BASE/runs" -H 'content-type: application/json' -d "{\"flowId\":\"$INVALID_FLOW_ID\",\"name\":\"invalid flow run\"}")"
INV_RUN_ID="$(printf '%s' "$INV_RUN_JSON" | jqr 'j.run.id')"
[ -n "$INV_RUN_ID" ] || die "建非法流程 run 失败：$INV_RUN_JSON"
INV_START_CODE="$(req -o "$REPO/.tmp/e2e-invalid-start.json" -w '%{http_code}' \
  -X POST "$BASE/runs/$INV_RUN_ID/start" -H 'content-type: application/json' -d '{}')"
[ "$INV_START_CODE" = "400" ] || die "用非法流程起 run 返回 $INV_START_CODE（期望 400）：$(cat "$REPO/.tmp/e2e-invalid-start.json")"
# 文案口径：必须点名 executorCommand 且是可读中文（不要求出现「不能开跑」——启动路径
# 现在由 `_executorSpecOf` 的严格检查先给更具体的「非法的 executor 配置」）。
node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const t=String(j.error||"");if(!/executorCommand/.test(t)||!/[\u4e00-\u9fa5]/.test(t)||t.length<10){console.error("启动 400 文案不可读："+t);process.exit(1)}' "$REPO/.tmp/e2e-invalid-start.json"
ok "非法流程起 run → 400（$(cat "$REPO/.tmp/e2e-invalid-start.json" | jqr 'j.error')）"

# ── 6b 证据留档（容器内原文；下面会删现场，所以先落到仓库 .tmp/）────────────────
EVIDENCE_DIR="$REPO/.tmp/e2e-v07-evidence"
rm -rf "$EVIDENCE_DIR" && mkdir -p "$EVIDENCE_DIR"
printf '%s\n' "$WT_DETAIL" > "$EVIDENCE_DIR/worktree-detail.json"
printf '%s\n' "$WT_META" > "$EVIDENCE_DIR/worktree-run.json"
printf '%s\n' "$SUP_META_ON" > "$EVIDENCE_DIR/supervision-on-run.json"
printf '%s\n' "$SUP_META_OFF" > "$EVIDENCE_DIR/supervision-off-run.json"
printf '%s\n' "$FILTER_JSON" > "$EVIDENCE_DIR/workspace-filter.json"
{
  echo "# git -C $WT_PATH rev-parse --abbrev-ref HEAD"
  dex_sh "git -C '$WT_PATH' rev-parse --abbrev-ref HEAD"
  echo "# git -C $WT_PATH rev-parse --show-toplevel"
  dex_sh "git -C '$WT_PATH' rev-parse --show-toplevel"
  echo "# cat $WT_PATH/README.md"
  dex sh -c "cat '$WT_PATH/README.md'"
} > "$EVIDENCE_DIR/worktree-git.txt" 2>&1
cp "$REPO/.tmp/e2e-concurrency.log" "$EVIDENCE_DIR/concurrency.log"
ok "证据留档到 .tmp/e2e-v07-evidence/（worktree run.json / git HEAD / 并发快照 / supervision）"

# ── 6b 清理：本段造的 run / 流程 / worktree / 临时仓库 ─────────────────────────
for id in "$CONC_A_ID" "$CONC_B_ID" "$WT_ID" "$SUP_RUN_ID" "$BAD_WT_ID" "$INV_RUN_ID"; do
  req -X DELETE "$BASE/runs/$id" >/dev/null || true
done
req -X DELETE "$BASE/flows/$LONG_FLOW_ID" >/dev/null || true
req -X DELETE "$BASE/flows/$INVALID_FLOW_ID" >/dev/null || true
req -X DELETE "$BASE/flows/$CODEX_FLOW_ID" >/dev/null || true
dex sh -c "git -C /testbed/e2e-repo worktree remove --force '$WT_PATH' >/dev/null 2>&1 || true; rm -rf /testbed/e2e-repo '$WT_PATH'" || true
CLEANUP_REPORT="$(dex sh -c "
for id in $CONC_A_ID $CONC_B_ID $WT_ID $SUP_RUN_ID $BAD_WT_ID $INV_RUN_ID; do test -e $GUEST_HOME/flow-studio/runs/\$id && echo \"\$id run PRESENT\" || echo \"\$id run deleted\"; done
for id in $LONG_FLOW_ID $INVALID_FLOW_ID $CODEX_FLOW_ID; do test -e $GUEST_HOME/flow-studio/flows/\$id.json && echo \"\$id flow PRESENT\" || echo \"\$id flow deleted\"; done
test -e /testbed/e2e-repo && echo 'e2e-repo PRESENT' || echo 'e2e-repo deleted'
test -e '$WT_PATH' && echo 'worktree PRESENT' || echo 'worktree deleted'
")"
printf '%s\n' "$CLEANUP_REPORT" | tee "$EVIDENCE_DIR/cleanup.txt" | sed 's/^/  /'
ok "6b 现场已清理（6 个 run、3 个流程、worktree、/testbed/e2e-repo）"

say "7. 导出与落盘检查"
req "$BASE/runs/$RUN_ID/export" | head -3
dex sh -c "stat -c '%a %n' $GUEST_HOME/flow-studio/runs $GUEST_HOME/flow-studio/runs/$RUN_ID" || die "run 目录不存在"
ok "落盘正常"

say "8. 清理 run 与流程"
req -X DELETE "$BASE/runs/$RUN_ID" >/dev/null || true
req -X DELETE "$BASE/flows/$FLOW_ID" >/dev/null || true
ok "已删除 run $RUN_ID 与流程 $FLOW_ID"

say "9. 宿主隔离回归（只读 systemctl，证明 dsh-web 没被重启）"
HOST_DSH_ACTIVE_AFTER="$(systemctl is-active dsh-web 2>/dev/null || true)"
HOST_DSH_START_AFTER="$(systemctl show -p ActiveEnterTimestamp --value dsh-web 2>/dev/null || true)"
{
  printf 'systemctl is-active dsh-web = %s\n' "$HOST_DSH_ACTIVE_AFTER"
  printf 'ActiveEnterTimestamp (跑之前) = %s\n' "$HOST_DSH_START_BEFORE"
  printf 'ActiveEnterTimestamp (跑之后) = %s\n' "$HOST_DSH_START_AFTER"
  printf '容器 = %s · 宿主端口 = %s\n' "$CONTAINER" "$PORT"
} | tee "$EVIDENCE_DIR/host-isolation.txt" | sed 's/^/  /'
[ "$HOST_DSH_ACTIVE_AFTER" = "active" ] || die "宿主 dsh-web 不是 active（$HOST_DSH_ACTIVE_AFTER）"
[ "$HOST_DSH_START_AFTER" = "$HOST_DSH_START_BEFORE" ] || die "宿主 dsh-web 启动时间变了：$HOST_DSH_START_BEFORE → $HOST_DSH_START_AFTER（可能被重启）"
ok "宿主 dsh-web 未被重启（启动时间保持 $HOST_DSH_START_AFTER）"
echo
ok "Docker e2e 全部通过（版本 $VERSION，容器 $CONTAINER）"
