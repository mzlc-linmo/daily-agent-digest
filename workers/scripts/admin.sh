#!/bin/sh
# 成员 Key 的管理入口(签发 / 列出 / 撤销),免去手搓 curl。
#
#   workers/scripts/admin.sh list
#   workers/scripts/admin.sh issue <成员ID> <姓名> <open_id 或 邮箱>
#   workers/scripts/admin.sh revoke <key_id>
#
# 管理口令来源(按顺序):
#   1. 环境变量 ADMIN_TOKEN
#   2. 本机钥匙串 service=daily-agent-digest account=admin-token
# 存进钥匙串一次即可(它会提示你输入口令):
#   security add-generic-password -s daily-agent-digest -a admin-token -w
set -eu

URL=${DIGEST_SUBMIT_URL:-https://daily-agent-digest-submit.mzlc.workers.dev}
TOKEN=${ADMIN_TOKEN:-}
if [ -z "$TOKEN" ] && command -v security >/dev/null 2>&1; then
  TOKEN=$(security find-generic-password -s daily-agent-digest -a admin-token -w 2>/dev/null || true)
fi
if [ -z "$TOKEN" ]; then
  cat >&2 <<'MSG'
未找到管理口令。二选一:
  export ADMIN_TOKEN='<你设置的口令>'
  security add-generic-password -s daily-agent-digest -a admin-token -w     # 存进钥匙串,以后免输入
MSG
  exit 2
fi

command=${1:-}
shift 2>/dev/null || true

case "$command" in
  list)
    curl -sS "$URL/admin/keys" -H "Authorization: Bearer $TOKEN" | python3 -c "
import json,sys
raw = sys.stdin.read().strip()
try:
    d = json.loads(raw)
except Exception:
    print('请求失败,原始返回:', raw[:400] or '(空响应)'); raise SystemExit(1)
for k in d.get('keys', []):
    print(f\"  {k['key_id']}  {k['member']}({k['member_id']})  enabled={k['enabled']}  linked={k['linked']}  签发={k.get('created_at')}\")
print(f\"  共 {len(d.get('keys', []))} 把\")
"
    ;;
  issue)
    member_id=${1:?用法: admin.sh issue <成员ID> <姓名> <open_id 或 邮箱>}
    member=${2:?缺少姓名}
    identity=${3:?缺少 open_id 或邮箱}
    case "$identity" in
      ou_*|on_*) field=open_id ;;
      *@*)       field=email ;;
      *) echo "第三个参数看起来既不是 open_id(ou_…)也不是邮箱" >&2; exit 2 ;;
    esac
    printf '{"member_id":"%s","member":"%s","%s":"%s"}' "$member_id" "$member" "$field" "$identity" \
      | curl -sS -X POST "$URL/admin/keys" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data-binary @- \
      | python3 -c "
import json,sys
raw = sys.stdin.read().strip()
try:
    d = json.loads(raw)
except Exception:
    print('签发请求失败,原始返回:', raw[:400] or '(空响应)'); raise SystemExit(1)
if 'key' not in d:
    print('签发失败:', json.dumps(d, ensure_ascii=False)); raise SystemExit(1)
print('✅ 已签发(明文 Key 只显示这一次):')
print('  ', d['key'])
print('   成员:', d['member'], f\"({d['member_id']})\", '| key_id:', d['key_id'])
if d.get('registry'): print('   台账:', ', '.join(d['registry']))
print('   下一步:把 Key 交给该成员,填进 App 的「设置」。')
"
    ;;
  revoke)
    key_id=${1:?用法: admin.sh revoke <key_id>}
    printf '{"key_id":"%s"}' "$key_id" \
      | curl -sS -X POST "$URL/admin/keys/revoke" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data-binary @- \
      | python3 -c "
import json,sys
raw = sys.stdin.read().strip()
try:
    d = json.loads(raw)
except Exception:
    print('撤销请求失败,原始返回:', raw[:400] or '(空响应)'); raise SystemExit(1)
if 'key_id' not in d:
    print('撤销失败:', json.dumps(d, ensure_ascii=False)); raise SystemExit(1)
print(f\"✅ 已撤销 {d['key_id']}({d.get('member','')}),下一次请求立即失效\")
"
    ;;
  *)
    cat >&2 <<'MSG'
用法:
  workers/scripts/admin.sh list
  workers/scripts/admin.sh issue <成员ID> <姓名> <open_id 或 邮箱>
  workers/scripts/admin.sh revoke <key_id>

找人:node workers/scripts/find-openid.mjs <姓名>
MSG
    exit 2
    ;;
esac
