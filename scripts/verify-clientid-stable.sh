#!/bin/bash
# ============================================================================
# clientId 稳定性回归验证（backend §5.1.2，2026-09-17 新增）
#
# 断言「同一设备指纹 + 同一激活码，任意次数重复激活返回同一 clientId」，
# 同时确认令牌仍在轮换（clientId 稳定 ≠ 会话不更新）。
#
# 用法（建议先复制一份数据库，避免污染 dev.db）：
#   cp prisma/dev.db /tmp/cid-verify.db
#   PORT=3100 DATABASE_URL="file:/tmp/cid-verify.db" ./node_modules/.bin/tsx src/server.ts &
#   bash scripts/verify-clientid-stable.sh
#
# 可用环境变量覆盖：BASE（默认 http://127.0.0.1:3100）、DB（默认 /tmp/cid-verify.db）
# ============================================================================
set -u
BASE="${BASE:-http://127.0.0.1:3100}"
DB="${DB:-/tmp/cid-verify.db}"
TS=$(date +%s)
FP="fp-verify-$TS"
FAILED=0

jqget() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval('d'+sys.argv[1]))" "$1"; }
ck() { if [ "$1" = "1" ]; then echo "  PASS  $2"; else echo "  FAIL  $2"; FAILED=1; fi; }

echo "=== 1. 平台管理员登录 ==="
ADMIN=$(curl -s --noproxy '*' -X POST "$BASE/api/platform/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"${PLATFORM_EMAIL:-admin@platform.example}\",\"password\":\"${PLATFORM_INITIAL_PASSWORD:-Admin12345}\"}" \
  | jqget "['data']['token']")
[ -n "$ADMIN" ] || { echo "管理员登录失败，请检查 PLATFORM_EMAIL / PLATFORM_INITIAL_PASSWORD"; exit 1; }

echo "=== 2. 建团队 + 3. 建密钥 ==="
TEAM=$(curl -s --noproxy '*' -X POST "$BASE/api/platform/teams" -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" \
  -d "{\"name\":\"cid-$TS\",\"supervisorEmail\":\"cid$TS@matreko.local\",\"expiresAt\":\"2027-12-31T23:59:59+08:00\",\"portQuota\":10,\"translationQuota\":100000}")
SUP_EMAIL=$(echo "$TEAM" | jqget "['data']['supervisor']['email']")
SUP_PWD=$(echo "$TEAM" | jqget "['data']['initialPassword']")
SUP=$(curl -s --noproxy '*' -X POST "$BASE/api/supervisor/auth/login" -H "Content-Type: application/json" \
  -d "{\"email\":\"$SUP_EMAIL\",\"password\":\"$SUP_PWD\"}" | jqget "['data']['token']")
CODE=$(curl -s --noproxy '*' -X POST "$BASE/api/supervisor/licenses" -H "Authorization: Bearer $SUP" -H "Content-Type: application/json" \
  -d '{"nickname":"clientId 稳定性验证"}' | jqget "['data']['plaintextCode']")
echo "code=$CODE"

act() { curl -s --noproxy '*' -X POST "$BASE/api/client/activate" -H "Content-Type: application/json" \
  -d "{\"code\":\"$CODE\",\"fingerprint\":\"$1\",\"deviceLabel\":\"$2\"}"; }

echo ""
echo "=== 4. 激活① 设备A 首次 ==="
A1=$(act "$FP" "验证机-A")
CID1=$(echo "$A1" | jqget "['data']['clientId']")
RT1=$(echo "$A1" | jqget "['data']['refreshToken']")
AT1=$(echo "$A1" | jqget "['data']['accessToken']")
KEYID=$(echo "$A1" | jqget "['data']['keyId']")
DEVID=$(echo "$A1" | jqget "['data']['device']['id']")
echo "clientId=$CID1"

echo ""
echo "=== 5. 激活② 设备A 同指纹 + 同激活码 重复激活 ==="
A2=$(act "$FP" "验证机-A")
CID2=$(echo "$A2" | jqget "['data']['clientId']")
RT2=$(echo "$A2" | jqget "['data']['refreshToken']")
AT2=$(echo "$A2" | jqget "['data']['accessToken']")
echo "alreadyActivated=$(echo "$A2" | jqget "['data']['alreadyActivated']")  clientId=$CID2"

echo ""
echo "=== 6. 激活③ 设备B 不同指纹（先开多开） ==="
curl -s --noproxy '*' -o /dev/null -X POST "$BASE/api/supervisor/licenses/$KEYID/multi-device" \
  -H "Authorization: Bearer $SUP" -H "Content-Type: application/json" -d '{"enabled":true}'
CID3=$(act "fp-other-$TS" "验证机-B" | jqget "['data']['clientId']")
echo "clientId=$CID3"

echo ""
echo "=== 7. 续期（renew）后 clientId ==="
CID4=$(curl -s --noproxy '*' -X POST "$BASE/api/client/auth/renew" -H "Authorization: Bearer $RT2" \
  -H "X-Device-Fingerprint: $FP" -H "Content-Type: application/json" -d "{\"oldAccessToken\":\"$AT2\"}" \
  | jqget "['data']['clientId']")
echo "clientId=$CID4"

echo ""
echo "=== 8. 主管解绑设备A → 重新激活（库中凭据已删，仍应同一 clientId） ==="
curl -s --noproxy '*' -o /dev/null -w "unbind HTTP %{http_code}\n" -X POST "$BASE/api/supervisor/devices/$DEVID/unbind" \
  -H "Authorization: Bearer $SUP" -H "Content-Type: application/json" -d '{"confirm":true}'
CID5=$(act "$FP" "验证机-A" | jqget "['data']['clientId']")
echo "clientId=$CID5"

echo ""
echo "=== 9. 库内凭据条数 + 断言 ==="
DB="$DB" python3 - "$CID1" "$CID2" "$CID3" "$CID4" "$CID5" "$KEYID" <<'EOF'
import os, sqlite3, sys
cid1, cid2, cid3, cid4, cid5, keyid = sys.argv[1:7]
rows = sqlite3.connect(os.environ['DB']).execute(
    "select clientId, deviceFingerprintHash from client_credentials where keyId=?", (keyid,)).fetchall()
print("ClientCredential 行数:", len(rows), "(应为 2：设备A + 设备B)")
for r in rows: print("   ", r)
def ck(ok, name): print(("  PASS  " if ok else "  FAIL  ") + name)
ck(cid1 == cid2, "同指纹重复激活 clientId 一致（核心诉求）")
ck(cid2 == cid4, "续期后 clientId 不变")
ck(cid1 == cid5, "解绑后重新激活 clientId 仍一致")
ck(cid1 != cid3, "不同指纹 → 不同 clientId")
ck(cid1.startswith('cli_') and len(cid1) == 26, "clientId 格式 cli_ + 22 字符（与旧实现等长）")
ck(len(rows) == 2, "同设备凭据不重复堆积（每设备 1 条）")
EOF
[ "$CID1" = "$CID2" ] && [ "$CID2" = "$CID4" ] && [ "$CID1" = "$CID5" ] && [ "$CID1" != "$CID3" ] || FAILED=1

echo ""
echo "=== 10. 令牌确实轮换（clientId 稳定 ≠ 会话不变） ==="
echo "  refreshToken 变化: $([ "$RT1" != "$RT2" ] && echo True || echo False)"
echo "  accessToken  变化: $([ "$AT1" != "$AT2" ] && echo True || echo False)"

echo ""
[ "$FAILED" = "0" ] && echo "✅ 全部通过" || { echo "❌ 存在失败项"; exit 1; }
