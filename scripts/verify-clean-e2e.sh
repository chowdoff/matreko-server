#!/bin/bash
set -e
BASE="http://localhost:3000"
TS=$(date +%s)
EXPIRES="2027-12-31T23:59:59+08:00"

echo "=== 1. 超级管理员登录 ==="
ADMIN_TOKEN=$(curl -s -X POST "$BASE/api/platform/auth/login" -H "Content-Type: application/json" \
  -d '{"email":"admin@matreko.local","password":"Admin12345"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['token'])")
echo "OK admin token: ${ADMIN_TOKEN:0:20}..."

echo ""
echo "=== 2. 创建团队 ==="
TEAM=$(curl -s -X POST "$BASE/api/platform/teams" -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"name\":\"v$TS\",\"supervisorEmail\":\"v$TS@matreko.local\",\"expiresAt\":\"$EXPIRES\",\"portQuota\":10,\"translationQuota\":1500000}")
TEAM_ID=$(echo "$TEAM" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['team']['id'])")
SUP_EMAIL=$(echo "$TEAM" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['supervisor']['email'])")
SUP_PWD=$(echo "$TEAM" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['initialPassword'])")
echo "teamId=$TEAM_ID sup=$SUP_EMAIL pwd=$SUP_PWD"

echo ""
echo "=== 3. 主管登录 ==="
SUP_TOKEN=$(curl -s -X POST "$BASE/api/supervisor/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$SUP_EMAIL\",\"password\":\"$SUP_PWD\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['token'])")
echo "OK sup token: ${SUP_TOKEN:0:20}..."

echo ""
echo "=== 4. 生成密钥（应加密存储） ==="
KEY_RESP=$(curl -s -X POST "$BASE/api/supervisor/licenses" -H "Authorization: Bearer $SUP_TOKEN" -H "Content-Type: application/json" \
  -d '{"nickname":"全链路密钥"}')
KEY_CODE=$(echo "$KEY_RESP" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['plaintextCode'])")
echo "明文: $KEY_CODE"

echo ""
echo "=== 5. 密钥列表（验证字段） ==="
curl -s -X GET "$BASE/api/supervisor/licenses" -H "Authorization: Bearer $SUP_TOKEN" | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']['licenses'][0]
print('licenseCode:', d['licenseCode'])
print('codePrefix存在:', 'codePrefix' in d, '| codeHash存在:', 'codeHash' in d, '| code原始字段:', 'code' in d)
"

echo ""
echo "=== 6. 激活密钥 ==="
ACT=$(curl -s -X POST "$BASE/api/client/activate" -H "Content-Type: application/json" \
  -d "{\"code\":\"$KEY_CODE\",\"fingerprint\":\"fp-$TS\",\"deviceLabel\":\"验证机\"}")
ACCESS=$(echo "$ACT" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['accessToken'])")
echo "OK accessToken: ${ACCESS:0:20}..."

echo ""
echo "=== 7. 申请端口 ==="
LEASE_ID=$(curl -s -X POST "$BASE/api/client/ports/acquire" -H "Authorization: Bearer $ACCESS" -H "X-Device-Fingerprint: fp-$TS" -H "Content-Type: application/json" \
  -d '{"channelAccountKey":"tg:v1"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['leaseId'])")
echo "leaseId=$LEASE_ID"

echo ""
echo "=== 8. 主管端口列表 ==="
curl -s -X GET "$BASE/api/supervisor/ports" -H "Authorization: Bearer $SUP_TOKEN" | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']
l=d[0]
print('licenseCode:', l['licenseCode'])
print('keyPrefix存在:', 'keyPrefix' in l, '| code原始字段:', 'code' in l)
"

echo ""
echo "=== 9. 管理员端口列表 ==="
curl -s -X GET "$BASE/api/platform/ports" -H "Authorization: Bearer $ADMIN_TOKEN" | python3 -c "
import sys,json
d=json.load(sys.stdin)['data']
l=d[0]
print('licenseCode:', l['licenseCode'])
print('keyPrefix存在:', 'keyPrefix' in l)
"

echo ""
echo "=== 10. 验证 DB 中无 codePrefix/codeHash 列 ==="
cd /Users/leiyq/WorkBuddy/2026-08-17-19-23-31 && npx tsx -e "
import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
p.\$queryRawUnsafe(\"SELECT name FROM pragma_table_info('license_keys') WHERE name IN ('codePrefix','codeHash')\")
  .then(r => { console.log('残留列:', JSON.stringify(r)); return p.\$disconnect(); });
" 2>&1 | grep -v "^\["

echo ""
echo "ALL DONE"
