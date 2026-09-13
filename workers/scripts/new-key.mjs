# 生成一把成员 API Key(本地执行,服务端永远看不到明文)
#
#   node workers/scripts/new-key.mjs zhangsan 张三 zhangsan@company.com
#   → 明文 Key:dag_k1a2b3c4_<secret>
#   → 写入 API_KEYS 的条目:{"k1a2b3c4":{"hash":"...","member":"张三","member_id":"zhangsan","enabled":true}}
#
# 把明文 Key 发给成员一次(存进 App 的「设置」),把 JSON 条目加进 Cloudflare 的 API_KEYS。
import { randomBytes } from 'node:crypto';

const [, , memberId, member, email] = process.argv;
if (!memberId || !member) {
  console.error('用法: node workers/scripts/new-key.mjs <成员ID> <姓名> [飞书邮箱]');
  console.error('  邮箱用于把「成员」人员字段关联到飞书通讯录(需要 contact:user.id:readonly)');
  process.exit(2);
}

const keyId = randomBytes(4).toString('hex');
const secret = randomBytes(32).toString('base64url');
const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)))]
  .map((b) => b.toString(16).padStart(2, '0'))
  .join('');

console.log(`明文 Key(只发给成员一次):dag_${keyId}_${secret}`);
console.log('');
console.log('加入 API_KEYS 的条目:');
const entry = { hash, member, member_id: memberId, enabled: true };
if (email) entry.email = email;
console.log(JSON.stringify({ [keyId]: entry }, null, 2));
