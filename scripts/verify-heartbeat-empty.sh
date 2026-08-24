#!/bin/bash
set -e
BASE="http://localhost:3000"
TS=$(date +%s)
EXPIRES="2027-12-31T23:59:59+08:00"

echo "=== 超级管理员登录 ==="
ADMIN_TOKEN=$(curl -s -X POST "$BASE/api/platform/auth/login" -H "Content-Type: application/json" \
  -d '{"email":"admin@matreko.local","password":"Admin12345"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['token'])")

echo "=== 创建团队 ==="
TEAM=$(curl -s -X POST "$BASE/api/platform/teams" -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"name\":\"hb$TS\",\"supervisorEmail\":\"hb$TS@matreko.local\",\"expiresAt\":\"$EXPIRES\",\"portQuota\":10,\"translationQuota\":1500000}")
SUP_EMAIL=$(echo "$TEAM" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['supervisor']['email'])")
SUP_PWD=$(echo "$TEAM" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['initialPassword'])")

echo "=== 主管登录 ==="
SUP_TOKEN=$(curl -s -X POST "$BASE/api/supervisor/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$SUP_EMAIL\",\"password\":\"$SUP_PWD\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['token'])")

echo "=== 生成密钥 + 激活 ==="
KEY_CODE=$(curl -s -X POST "$BASE/api/supervisor/licenses" -H "Authorization: Bearer $SUP_TOKEN" -H "Content-Type: application/json" \
  -d '{"nickname":"hb密钥"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['plaintextCode'])")
ACT=$(curl -s -X POST "$BASE/api/client/activate" -H "Content-Type: application/json" \
  -d "{\"code\":\"$KEY_CODE\",\"fingerprint\":\"fp-hb-$TS\",\"deviceLabel\":\"hb机\"}")
ACCESS=$(echo "$ACT" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['accessToken'])")

echo "=== 申请 3 个端口（构造 held=3） ==="
for i in 1 2 3; do
  curl -s -X POST "$BASE/api/client/ports/acquire" -H "Authorization: Bearer $ACCESS" -H "X-Device-Fingerprint: fp-hb-$TS" -H "Content-Type: application/json" \
    -d "{\"channelAccountKey\":\"tg:hb$i\"}" > /dev/null
done

echo ""
echo "=== 7.3 心跳（空数组）→ 预期 200 + refreshed=[] revoked=[] heldCount=3 ==="
curl -s -o /tmp/hb_resp.json -w "HTTP_STATUS=%{http_code}\n" -X POST "$BASE/api/client/ports/heartbeat" \
  -H "Authorization: Bearer $ACCESS" -H "X-Device-Fingerprint: fp-hb-$TS" -H "Content-Type: application/json" \
  -d '{"leaseIds":[]}'
echo "响应体："
cat /tmp/hb_resp.json | python3 -m json.tool

echo ""
echo "=== 清理团队 ==="
cd /Users/leiyq/WorkBuddy/2026-08-17-19-23-31 && npx tsx scripts/wipe-data.ts 2>&1 | grep -v "^\[" | tail -3
