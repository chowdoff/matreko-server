#!/bin/bash
# 渠道账号登记 + 主管端账号列表 回归验证
#   PRD：P0-C-03 AC1、P0-C-18 AC1/AC12/AC15/AC18/AC20、P0-B-10 AC1
#   设计：channel-account-design.md
# 分段：
#   1~9   登记/对账/软删复活/幂等/越权/入参校验
#   3.1   新列字段：所属密钥（明文）+ 客服名称 + 代理出口（协议+地区码）
#   8.1   代理出口字段语义：变更生效 / 省略不覆盖 / DIRECT 清空地区
#   10    设备在线判据（心跳保活 lastActiveAt）回归
#        契约：client-keepalive-contract.md；后端说明：backend.md §6.3
#
# 前置：在**隔离库**上启动服务（避免污染 dev.db）：
#   cp prisma/dev.db /tmp/ca-verify.db
#   PORT=3100 DATABASE_URL="file:/tmp/ca-verify.db" ./node_modules/.bin/tsx src/server.ts
#   （服务启动约 20+ 秒，需等 🚀 服务已启动 后再跑本脚本）
#
# 用法：BASE=http://127.0.0.1:3100 DB=/tmp/ca-verify.db bash scripts/verify-channel-accounts.sh

BASE="${BASE:-http://127.0.0.1:3100}"
DB="${DB:-/tmp/ca-verify.db}"
PLATFORM_EMAIL="${PLATFORM_EMAIL:-admin@platform.example}"
PLATFORM_PASSWORD="${PLATFORM_INITIAL_PASSWORD:-Admin12345}"
TS=$(date +%s)
EXPIRES="2027-12-31T23:59:59+08:00"
FAILED=0

req() { curl -s --noproxy '*' "$@"; }
# 从 JSON 中取值：jq_get '<表达式>'  (d = 已解析的 data 字段)
dget() { python3 -c "
import sys, json
r = json.load(sys.stdin)
d = r.get('data', r)
print($1)
"; }
pass() { echo "✅ $1"; }
fail() { echo "❌ FAIL: $1"; FAILED=$((FAILED + 1)); }
check_eq() { # check_eq <期望> <实际> <描述>
  if [ "$1" = "$2" ]; then pass "$3（= $2）"; else fail "$3：期望 [$1]，实际 [$2]"; fi
}

echo "═══ 0. 准备：平台管理员 → 团队 → 主管 → 密钥 → 设备1 激活 ═══"
ADMIN_TOKEN=$(req -X POST "$BASE/api/platform/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$PLATFORM_EMAIL\",\"password\":\"$PLATFORM_PASSWORD\"}" | dget "d['token']")
TEAM=$(req -X POST "$BASE/api/platform/teams" -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"name\":\"ca$TS\",\"supervisorEmail\":\"ca$TS@matreko.local\",\"expiresAt\":\"$EXPIRES\",\"portQuota\":10,\"translationQuota\":1500000}")
SUP_TOKEN=$(req -X POST "$BASE/api/supervisor/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$(echo "$TEAM" | dget "d['supervisor']['email']")\",\"password\":\"$(echo "$TEAM" | dget "d['initialPassword']")\"}" | dget "d['token']")

LIC=$(req -X POST "$BASE/api/supervisor/licenses" -H "Authorization: Bearer $SUP_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"nickname\":\"ca密钥$TS\"}")
LIC_ID=$(echo "$LIC" | dget "d['licenseKey']['id']")
LIC_CODE=$(echo "$LIC" | dget "d['plaintextCode']")

FP1="fp-ca-$TS"
ACT1=$(req -X POST "$BASE/api/client/activate" -H 'Content-Type: application/json' \
  -d "{\"code\":\"$LIC_CODE\",\"fingerprint\":\"$FP1\",\"deviceLabel\":\"验证机-A\"}")
ACCESS1=$(echo "$ACT1" | dget "d['accessToken']")
CID1=$(echo "$ACT1" | dget "d['clientId']")
echo "clientId(设备1) = $CID1"

ACC_A="acc-A-$TS"
ACC_B="acc-B-$TS"
ACC_C="acc-C-$TS"

echo ""
echo "═══ 1. 申请端口 → 客户端未对账也应自动补登（过渡期兜底） ═══"
ACQ=$(req -X POST "$BASE/api/client/ports/acquire" \
  -H "Authorization: Bearer $ACCESS1" -H "X-Device-Fingerprint: $FP1" -H 'Content-Type: application/json' \
  -d "{\"channelAccountKey\":\"telegram:$ACC_A\",\"channelAccountId\":\"$ACC_A\",\"channel\":\"TELEGRAM\"}")
LEASE_A=$(echo "$ACQ" | dget "d['leaseId']")
check_eq "$ACC_A" "$(echo "$ACQ" | dget "d['channelAccountId']")" "acquire 返回规范化 channelAccountId"

L1=$(req "$BASE/api/supervisor/accounts" -H "Authorization: Bearer $SUP_TOKEN")
check_eq "1" "$(echo "$L1" | dget "len(d['items'])")" "主管端立即可见（acquire 自动补登）"
check_eq "ONLINE" "$(echo "$L1" | dget "d['items'][0]['status']")" "未上报 channelStatus 时按心跳窗口兜底为 ONLINE"
check_eq "$ACC_A" "$(echo "$L1" | dget "d['items'][0]['accountName']")" "自动补登的别名退化为标识"

echo ""
echo "═══ 2. 全量对账：3 个账号（1 已启动 + 2 从未启动） ═══"
SYNC=$(req -X PUT "$BASE/api/client/accounts" \
  -H "Authorization: Bearer $ACCESS1" -H "X-Device-Fingerprint: $FP1" -H 'Content-Type: application/json' \
  -d "{\"accounts\":[
        {\"channelAccountId\":\"$ACC_A\",\"channel\":\"TELEGRAM\",\"accountName\":\"东南亚主号\",\"proxyProtocol\":\"SOCKS5\",\"proxyRegion\":\"SG\"},
        {\"channelAccountId\":\"$ACC_B\",\"channel\":\"WHATSAPP\",\"accountName\":\"中东客服A\",\"proxyProtocol\":\"DIRECT\"},
        {\"channelAccountId\":\"$ACC_C\",\"channel\":\"TELEGRAM\",\"accountName\":\"越南备号\",\"proxyProtocol\":\"HTTP\",\"proxyRegion\":\"HK\"}
      ]}")
check_eq "2" "$(echo "$SYNC" | dget "d['created']")" "created（A 已存在→更新；B/C 新建）"
check_eq "1" "$(echo "$SYNC" | dget "d['updated']")" "updated（A 别名被真实名称覆盖）"
check_eq "0" "$(echo "$SYNC" | dget "d['deleted']")" "deleted"
check_eq "3" "$(echo "$SYNC" | dget "d['total']")" "total"

echo ""
echo "═══ 3. 已添加但从未启动的账号必须在列表中（P0-B-10 AC1 核心） ═══"
L2=$(req "$BASE/api/supervisor/accounts" -H "Authorization: Bearer $SUP_TOKEN")
check_eq "3" "$(echo "$L2" | dget "d['summary']['total']")" "summary.total"
check_eq "2" "$(echo "$L2" | dget "d['summary']['notStarted']")" "summary.notStarted"
check_eq "1" "$(echo "$L2" | dget "d['summary']['online']")" "summary.online"
check_eq "1" "$(echo "$L2" | dget "d['summary']['portsHeld']")" "summary.portsHeld"
echo "$L2" | python3 -c "
import sys, json
items = json.load(sys.stdin)['data']['items']
by = {i['channelAccountId']: i for i in items}
ok = True
b = by.get('$ACC_B', {})
if b.get('status') != 'NOT_STARTED': print('  B.status =', b.get('status')); ok = False
if b.get('leaseId') is not None: print('  B.leaseId 应为 null'); ok = False
if b.get('acquiredAt') is not None: print('  B.acquiredAt 应为 null'); ok = False
if not b.get('createdAt'): print('  B.createdAt 缺失'); ok = False
a = by.get('$ACC_A', {})
if a.get('accountName') != '东南亚主号': print('  A.accountName =', a.get('accountName')); ok = False
if not a.get('acquiredAt') or not a.get('lastSeenAt'): print('  A 应有 acquiredAt/lastSeenAt'); ok = False
print('✅ 未启动账号：status=NOT_STARTED / leaseId=null / acquiredAt=null / 有 createdAt' if ok else '❌ FAIL 未启动账号字段语义')
sys.exit(0 if ok else 3)
" || FAILED=$((FAILED + 1))

echo ""
echo "═══ 3.1 「所属密钥/客服」+「代理出口」字段（P0-B-10 AC1 新列） ═══"
# 用 here-doc（引号定界符）传 python：避免 bash 双层转义 + 中文在命令行上被破坏
echo "$L2" > /tmp/ka-accounts-list.json
python3 - "$ACC_A" "$ACC_B" "$ACC_C" "$TS" <<'PY' || FAILED=$((FAILED + 1))
import json, sys
a_id, b_id, c_id, ts = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
items = json.load(open('/tmp/ka-accounts-list.json'))['data']['items']
by = {i['channelAccountId']: i for i in items}
a, b, c = by.get(a_id, {}), by.get(b_id, {}), by.get(c_id, {})
problems = []

# 所属密钥：AES 解密的密钥明文 + 客服名称（= 密钥昵称）
if not (a.get('licenseCode') or '').startswith('MTRK-'):
    problems.append('A.licenseCode 应为 MTRK- 开头的密钥明文，实际 %r' % a.get('licenseCode'))
if a.get('keyNickname') != 'ca密钥' + ts:
    problems.append('A.keyNickname 应为 ca密钥%s，实际 %r' % (ts, a.get('keyNickname')))

# 代理出口：结构化两字段（协议 + ISO 地区码），而非展示串
if a.get('proxyProtocol') != 'SOCKS5' or a.get('proxyRegion') != 'SG':
    problems.append('A 应为 SOCKS5/SG，实际 %r/%r' % (a.get('proxyProtocol'), a.get('proxyRegion')))
if c.get('proxyProtocol') != 'HTTP' or c.get('proxyRegion') != 'HK':
    problems.append('C 应为 HTTP/HK，实际 %r/%r' % (c.get('proxyProtocol'), c.get('proxyRegion')))
if b.get('proxyProtocol') != 'DIRECT' or b.get('proxyRegion') is not None:
    problems.append('B（直连）应为 DIRECT + region=null，实际 %r/%r' % (b.get('proxyProtocol'), b.get('proxyRegion')))
if 'proxyExit' in a:
    problems.append('响应不应再出现旧的展示串字段 proxyExit')

print('✅ 密钥明文 / 客服名称 / 代理出口（协议+地区码）均正确' if not problems else '❌ FAIL ' + '；'.join(problems))
sys.exit(0 if not problems else 3)
PY

echo ""
echo "═══ 4. 幂等：重复提交同一快照（含代理字段） ═══"
SYNC2=$(req -X PUT "$BASE/api/client/accounts" \
  -H "Authorization: Bearer $ACCESS1" -H "X-Device-Fingerprint: $FP1" -H 'Content-Type: application/json' \
  -d "{\"accounts\":[
        {\"channelAccountId\":\"$ACC_A\",\"channel\":\"TELEGRAM\",\"accountName\":\"东南亚主号\",\"proxyProtocol\":\"SOCKS5\",\"proxyRegion\":\"SG\"},
        {\"channelAccountId\":\"$ACC_B\",\"channel\":\"WHATSAPP\",\"accountName\":\"中东客服A\",\"proxyProtocol\":\"DIRECT\"},
        {\"channelAccountId\":\"$ACC_C\",\"channel\":\"TELEGRAM\",\"accountName\":\"越南备号\",\"proxyProtocol\":\"HTTP\",\"proxyRegion\":\"HK\"}
      ]}")
check_eq "0" "$(echo "$SYNC2" | dget "d['created']")" "幂等 created"
check_eq "0" "$(echo "$SYNC2" | dget "d['updated']")" "幂等 updated（无变化不写库）"
check_eq "0" "$(echo "$SYNC2" | dget "d['deleted']")" "幂等 deleted"

echo ""
echo "═══ 5. 快照删除 B → 软删；再添加 → 复活（P0-C-18 AC15/AC20） ═══"
SYNC3=$(req -X PUT "$BASE/api/client/accounts" \
  -H "Authorization: Bearer $ACCESS1" -H "X-Device-Fingerprint: $FP1" -H 'Content-Type: application/json' \
  -d "{\"accounts\":[
        {\"channelAccountId\":\"$ACC_A\",\"channel\":\"TELEGRAM\",\"accountName\":\"东南亚主号\",\"proxyProtocol\":\"SOCKS5\",\"proxyRegion\":\"SG\"},
        {\"channelAccountId\":\"$ACC_C\",\"channel\":\"TELEGRAM\",\"accountName\":\"越南备号\",\"proxyProtocol\":\"HTTP\",\"proxyRegion\":\"HK\"}
      ]}")
check_eq "1" "$(echo "$SYNC3" | dget "d['deleted']")" "移除 B → 软删 1 条"
check_eq "2" "$(echo "$SYNC3" | dget "d['total']")" "软删后 total=2"
check_eq "0" "$(sqlite3 "$DB" "SELECT count(*) FROM channel_accounts WHERE channelAccountId='$ACC_B' AND deletedAt IS NULL;")" "B 在库中已软删"

SYNC4=$(req -X PUT "$BASE/api/client/accounts" \
  -H "Authorization: Bearer $ACCESS1" -H "X-Device-Fingerprint: $FP1" -H 'Content-Type: application/json' \
  -d "{\"accounts\":[
        {\"channelAccountId\":\"$ACC_A\",\"channel\":\"TELEGRAM\",\"accountName\":\"东南亚主号\",\"proxyProtocol\":\"SOCKS5\",\"proxyRegion\":\"SG\"},
        {\"channelAccountId\":\"$ACC_B\",\"channel\":\"WHATSAPP\",\"accountName\":\"中东客服A\",\"proxyProtocol\":\"DIRECT\"},
        {\"channelAccountId\":\"$ACC_C\",\"channel\":\"TELEGRAM\",\"accountName\":\"越南备号\",\"proxyProtocol\":\"HTTP\",\"proxyRegion\":\"HK\"}
      ]}")
check_eq "1" "$(echo "$SYNC4" | dget "d['updated']")" "复活软删账号计入 updated（不重复追加）"
check_eq "3" "$(echo "$SYNC4" | dget "d['total']")" "复活后 total=3"
check_eq "1" "$(sqlite3 "$DB" "SELECT count(*) FROM channel_accounts WHERE channelAccountId='$ACC_B';")" "B 仍只有 1 行（未重复追加）"

echo ""
echo "═══ 6. 心跳上报 channelStatus（P0-C-03 AC4/AC8/AC9/AC10） ═══"
HB1=$(req -X POST "$BASE/api/client/ports/heartbeat" \
  -H "Authorization: Bearer $ACCESS1" -H "X-Device-Fingerprint: $FP1" -H 'Content-Type: application/json' \
  -d "{\"leaseIds\":[\"$LEASE_A\"],\"channelStatuses\":[{\"leaseId\":\"$LEASE_A\",\"status\":\"WAITING_QR\"}]}")
check_eq "1" "$(echo "$HB1" | dget "d['channelStatusUpdated']")" "channelStatus 写入数"
L3=$(req "$BASE/api/supervisor/accounts" -H "Authorization: Bearer $SUP_TOKEN")
check_eq "WAITING_QR" "$(echo "$L3" | dget "d['items'][0]['status'] if d['items'][0]['channelAccountId']=='$ACC_A' else 'x'")" "主管端反映 WAITING_QR"
check_eq "1" "$(echo "$L3" | dget "d['summary']['waitingQr']")" "summary.waitingQr"

echo ""
echo "═══ 7. 在线窗口统一为 5 分钟（回归「60s < 心跳 2min 误判离线」缺陷） ═══"
# 清掉权威 channelStatus，把 lastSeenAt 改为 3 分钟前：落在 5min 窗口内 → 应判 ONLINE
sqlite3 "$DB" "UPDATE port_leases SET channelStatus=NULL, lastSeenAt=(CAST(strftime('%s','now') AS INTEGER)-180)*1000 WHERE id='$LEASE_A';"
L4=$(req "$BASE/api/supervisor/accounts" -H "Authorization: Bearer $SUP_TOKEN")
check_eq "ONLINE" "$(echo "$L4" | dget "d['items'][0]['status'] if d['items'][0]['channelAccountId']=='$ACC_A' else 'x'")" "3 分钟未心跳仍判在线（旧实现 60s 会误判 OFFLINE）"
# 改为 6 分钟前：超出窗口 → OFFLINE
sqlite3 "$DB" "UPDATE port_leases SET lastSeenAt=(CAST(strftime('%s','now') AS INTEGER)-360)*1000 WHERE id='$LEASE_A';"
L5=$(req "$BASE/api/supervisor/accounts" -H "Authorization: Bearer $SUP_TOKEN")
check_eq "OFFLINE" "$(echo "$L5" | dget "d['items'][0]['status'] if d['items'][0]['channelAccountId']=='$ACC_A' else 'x'")" "6 分钟未心跳判离线"

echo ""
echo "═══ 8. 越权防护：设备2 不能写设备1 租约的 channelStatus ═══"
req -X POST "$BASE/api/supervisor/licenses/$LIC_ID/multi-device" -H "Authorization: Bearer $SUP_TOKEN" \
  -H 'Content-Type: application/json' -d '{"enabled":true}' > /dev/null
FP2="fp-ca2-$TS"
ACT2=$(req -X POST "$BASE/api/client/activate" -H 'Content-Type: application/json' \
  -d "{\"code\":\"$LIC_CODE\",\"fingerprint\":\"$FP2\",\"deviceLabel\":\"验证机-B\"}")
ACCESS2=$(echo "$ACT2" | dget "d['accessToken']")
CID2=$(echo "$ACT2" | dget "d['clientId']")
echo "clientId(设备2) = $CID2"
HB2=$(req -X POST "$BASE/api/client/ports/heartbeat" \
  -H "Authorization: Bearer $ACCESS2" -H "X-Device-Fingerprint: $FP2" -H 'Content-Type: application/json' \
  -d "{\"leaseIds\":[\"$LEASE_A\"],\"channelStatuses\":[{\"leaseId\":\"$LEASE_A\",\"status\":\"ONLINE\"}]}")
check_eq "0" "$(echo "$HB2" | dget "d['channelStatusUpdated']")" "他人租约不被写入"
check_eq "[]" "$(echo "$HB2" | dget "json.dumps(d['refreshedLeaseIds'])")" "他人租约不被刷新"
check_eq "" "$(sqlite3 "$DB" "SELECT COALESCE(channelStatus,'') FROM port_leases WHERE id='$LEASE_A';")" "设备1 租约 channelStatus 未被篡改"

echo ""
echo "═══ 8.1 代理出口字段语义（结构化存储 / DIRECT 清空地区 / 省略不覆盖） ═══"
acct_field() { # acct_field <channelAccountId> <字段名>；null 打印为 null
  req "$BASE/api/supervisor/accounts" -H "Authorization: Bearer $SUP_TOKEN" | python3 -c "
import sys, json
items = json.load(sys.stdin)['data']['items']
m = [i for i in items if i.get('channelAccountId') == '$1']
v = m[0].get('$2') if m else 'MISSING'
print('null' if v is None else v)
"
}

# ① 协议/地区变更生效（A: SOCKS5/SG → HTTP/HK）
req -X PUT "$BASE/api/client/accounts" \
  -H "Authorization: Bearer $ACCESS1" -H "X-Device-Fingerprint: $FP1" -H 'Content-Type: application/json' \
  -d "{\"accounts\":[
        {\"channelAccountId\":\"$ACC_A\",\"channel\":\"TELEGRAM\",\"accountName\":\"东南亚主号\",\"proxyProtocol\":\"HTTP\",\"proxyRegion\":\"HK\"},
        {\"channelAccountId\":\"$ACC_B\",\"channel\":\"WHATSAPP\",\"accountName\":\"中东客服A\",\"proxyProtocol\":\"DIRECT\"},
        {\"channelAccountId\":\"$ACC_C\",\"channel\":\"TELEGRAM\",\"accountName\":\"越南备号\",\"proxyProtocol\":\"HTTP\",\"proxyRegion\":\"HK\"}
      ]}" > /dev/null
check_eq "HTTP" "$(acct_field "$ACC_A" proxyProtocol)" "协议变更生效"
check_eq "HK" "$(acct_field "$ACC_A" proxyRegion)" "地区码变更生效"

# ② 老客户端（尚未实现代理上报）省略这两个字段 → 必须保留库中原值，不得清空
req -X PUT "$BASE/api/client/accounts" \
  -H "Authorization: Bearer $ACCESS1" -H "X-Device-Fingerprint: $FP1" -H 'Content-Type: application/json' \
  -d "{\"accounts\":[
        {\"channelAccountId\":\"$ACC_A\",\"channel\":\"TELEGRAM\",\"accountName\":\"东南亚主号\"},
        {\"channelAccountId\":\"$ACC_B\",\"channel\":\"WHATSAPP\",\"accountName\":\"中东客服A\"},
        {\"channelAccountId\":\"$ACC_C\",\"channel\":\"TELEGRAM\",\"accountName\":\"越南备号\"}
      ]}" > /dev/null
check_eq "HTTP" "$(acct_field "$ACC_A" proxyProtocol)" "省略 proxyProtocol 时保留原值"
check_eq "HK" "$(acct_field "$ACC_A" proxyRegion)" "省略 proxyRegion 时保留原值"
check_eq "DIRECT" "$(acct_field "$ACC_B" proxyProtocol)" "不涉及代理的账号不受影响"

# ③ 切成 DIRECT → 出口地区必须被清空（避免「DIRECT·新加坡」这类矛盾展示）
req -X PUT "$BASE/api/client/accounts" \
  -H "Authorization: Bearer $ACCESS1" -H "X-Device-Fingerprint: $FP1" -H 'Content-Type: application/json' \
  -d "{\"accounts\":[
        {\"channelAccountId\":\"$ACC_A\",\"channel\":\"TELEGRAM\",\"accountName\":\"东南亚主号\",\"proxyProtocol\":\"DIRECT\"},
        {\"channelAccountId\":\"$ACC_B\",\"channel\":\"WHATSAPP\",\"accountName\":\"中东客服A\",\"proxyProtocol\":\"DIRECT\"},
        {\"channelAccountId\":\"$ACC_C\",\"channel\":\"TELEGRAM\",\"accountName\":\"越南备号\",\"proxyProtocol\":\"HTTP\",\"proxyRegion\":\"HK\"}
      ]}" > /dev/null
check_eq "DIRECT" "$(acct_field "$ACC_A" proxyProtocol)" "切到本机直连"
check_eq "null" "$(acct_field "$ACC_A" proxyRegion)" "DIRECT 时响应 region=null"
check_eq "1" "$(sqlite3 "$DB" "SELECT count(*) FROM channel_accounts WHERE channelAccountId='$ACC_A' AND proxyRegion IS NULL;")" "DIRECT 时库中 region 已清空"

echo ""
echo "═══ 9. 入参校验与空快照 ═══"
CODE_BAD=$(req -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/client/accounts" \
  -H "Authorization: Bearer $ACCESS1" -H "X-Device-Fingerprint: $FP1" -H 'Content-Type: application/json' \
  -d "{\"accounts\":[{\"channelAccountId\":\"$ACC_A\",\"channel\":\"WECHAT\",\"accountName\":\"非法渠道\"}]}")
check_eq "400" "$CODE_BAD" "非法渠道 → 400"

CODE_PROTO=$(req -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/client/accounts" \
  -H "Authorization: Bearer $ACCESS1" -H "X-Device-Fingerprint: $FP1" -H 'Content-Type: application/json' \
  -d "{\"accounts\":[{\"channelAccountId\":\"$ACC_A\",\"channel\":\"TELEGRAM\",\"accountName\":\"非法协议\",\"proxyProtocol\":\"SHADOWSOCKS\"}]}")
check_eq "400" "$CODE_PROTO" "非法代理协议 → 400"

CODE_REGION=$(req -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/client/accounts" \
  -H "Authorization: Bearer $ACCESS1" -H "X-Device-Fingerprint: $FP1" -H 'Content-Type: application/json' \
  -d "{\"accounts\":[{\"channelAccountId\":\"$ACC_A\",\"channel\":\"TELEGRAM\",\"accountName\":\"小写地区码\",\"proxyProtocol\":\"SOCKS5\",\"proxyRegion\":\"sg\"}]}")
check_eq "400" "$CODE_REGION" "地区码必须为 ISO alpha-2 大写 → 400"

CODE_DIRECT_REGION=$(req -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/client/accounts" \
  -H "Authorization: Bearer $ACCESS1" -H "X-Device-Fingerprint: $FP1" -H 'Content-Type: application/json' \
  -d "{\"accounts\":[{\"channelAccountId\":\"$ACC_A\",\"channel\":\"TELEGRAM\",\"accountName\":\"直连带地区\",\"proxyProtocol\":\"DIRECT\",\"proxyRegion\":\"SG\"}]}")
check_eq "400" "$CODE_DIRECT_REGION" "DIRECT 携带 proxyRegion → 400"

# 出口地探测失败（P0-C-18 AC12）：只给协议不给地区码，必须照常接受
SYNC_PROTO_ONLY=$(req -X PUT "$BASE/api/client/accounts" \
  -H "Authorization: Bearer $ACCESS1" -H "X-Device-Fingerprint: $FP1" -H 'Content-Type: application/json' \
  -d "{\"accounts\":[
        {\"channelAccountId\":\"$ACC_A\",\"channel\":\"TELEGRAM\",\"accountName\":\"东南亚主号\",\"proxyProtocol\":\"DIRECT\"},
        {\"channelAccountId\":\"$ACC_B\",\"channel\":\"WHATSAPP\",\"accountName\":\"中东客服A\",\"proxyProtocol\":\"DIRECT\"},
        {\"channelAccountId\":\"$ACC_C\",\"channel\":\"TELEGRAM\",\"accountName\":\"越南备号\",\"proxyProtocol\":\"SOCKS5\"}
      ]}")
check_eq "1" "$(echo "$SYNC_PROTO_ONLY" | dget "d['updated']")" "只上报协议（出口地未知）照常接受"
check_eq "SOCKS5" "$(acct_field "$ACC_C" proxyProtocol)" "协议已写入"
check_eq "null" "$(acct_field "$ACC_C" proxyRegion)" "出口地未知时 region=null"

SYNC5=$(req -X PUT "$BASE/api/client/accounts" \
  -H "Authorization: Bearer $ACCESS1" -H "X-Device-Fingerprint: $FP1" -H 'Content-Type: application/json' \
  -d '{"accounts":[]}')
check_eq "3" "$(echo "$SYNC5" | dget "d['deleted']")" "空快照 → 全部软删"
check_eq "0" "$(echo "$SYNC5" | dget "d['total']")" "空快照后 total=0"
L6=$(req "$BASE/api/supervisor/accounts" -H "Authorization: Bearer $SUP_TOKEN")
check_eq "0" "$(echo "$L6" | dget "len(d['items'])")" "主管端列表为空（与客户端一致）"

echo ""
echo "═══ 10. 设备在线判据：心跳保活（假离线修复） ═══"
# 判据优先级：lastActiveAt（心跳）→ lastRenewedAt（老客户端）→ boundAt（无凭据）
dev_status() { # dev_status <deviceLabel> <field>
  req "$BASE/api/supervisor/devices" -H "Authorization: Bearer $SUP_TOKEN" | python3 -c "
import sys, json
items = json.load(sys.stdin)['data']['items']
m = [i for i in items if i.get('deviceLabel') == '$1']
print(m[0].get('$2') if m else 'MISSING')
"
}
# 10.1 激活即算一次活跃 → 设备在线，判据来源为心跳字段
check_eq "ONLINE" "$(dev_status '验证机-A' 'status')" "激活后设备在线"
check_eq "HEARTBEAT" "$(dev_status '验证机-A' 'lastSeenSource')" "在线判据来自 lastActiveAt"

# 10.2 老客户端兼容：无心跳记录（lastActiveAt=null）+ 3 分钟前续期 → 仍判在线，来源回落 RENEW
sqlite3 "$DB" "UPDATE client_credentials SET lastActiveAt=NULL, lastRenewedAt=(CAST(strftime('%s','now') AS INTEGER)-180)*1000 WHERE clientId='$CID1';"
check_eq "ONLINE" "$(dev_status '验证机-A' 'status')" "老客户端（无心跳）3 分钟内续期仍在线"
check_eq "RENEW" "$(dev_status '验证机-A' 'lastSeenSource')" "无心跳时判据回落 lastRenewedAt"

# 10.3 复现假离线：lastActiveAt=null + 6 分钟前续期（改造前必然显示离线）
sqlite3 "$DB" "UPDATE client_credentials SET lastActiveAt=NULL, lastRenewedAt=(CAST(strftime('%s','now') AS INTEGER)-360)*1000 WHERE clientId='$CID1';"
check_eq "OFFLINE" "$(dev_status '验证机-A' 'status')" "复现改造前的假离线场景"

# 10.4 核心修复：一次心跳（即使没有占用任何端口）即恢复在线
HB3=$(req -X POST "$BASE/api/client/ports/heartbeat" \
  -H "Authorization: Bearer $ACCESS1" -H "X-Device-Fingerprint: $FP1" -H 'Content-Type: application/json' \
  -d '{"leaseIds":[]}')
check_eq "[]" "$(echo "$HB3" | dget "json.dumps(d['refreshedLeaseIds'])")" "无租约时 refreshedLeaseIds 为空"
check_eq "True" "$(echo "$HB3" | dget "d['deviceActiveAt'] is not None")" "无租约时仍刷新设备活跃时间"
check_eq "ONLINE" "$(dev_status '验证机-A' 'status')" "心跳后设备恢复在线（假离线已修复）"
check_eq "HEARTBEAT" "$(dev_status '验证机-A' 'lastSeenSource')" "恢复后判据来源为心跳"
check_eq "1" "$(sqlite3 "$DB" "SELECT count(*) FROM client_credentials WHERE clientId='$CID1' AND lastActiveAt IS NOT NULL;")" "库中 lastActiveAt 已写入"

# 10.5 凭据失效可感知：解绑/登出后 ClientCredential 被删 → 心跳在鉴权层 401（客户端据此重新激活）
#      说明：`deviceActiveAt: null` 是「鉴权通过但无凭据」的防御性兜底分支，正常不会走到；
#      真实失效路径是 clientAuth 中间件校验凭据后直接 401 CREDENTIAL_REVOKED。
sqlite3 "$DB" "DELETE FROM client_credentials WHERE clientId='$CID1';"
HB4_CODE=$(req -o /tmp/ka-hb4.json -w '%{http_code}' -X POST "$BASE/api/client/ports/heartbeat" \
  -H "Authorization: Bearer $ACCESS1" -H "X-Device-Fingerprint: $FP1" -H 'Content-Type: application/json' \
  -d '{"leaseIds":[]}')
check_eq "401" "$HB4_CODE" "凭据被删后心跳返回 401"
check_eq "CREDENTIAL_REVOKED" "$(cat /tmp/ka-hb4.json | dget "d['error']['code']")" "错误码为 CREDENTIAL_REVOKED（客户端据此重新激活）"

echo ""
if [ "$FAILED" -eq 0 ]; then
  echo "🎉 全部断言通过"
  exit 0
else
  echo "💥 有 $FAILED 项断言失败"
  exit 1
fi
