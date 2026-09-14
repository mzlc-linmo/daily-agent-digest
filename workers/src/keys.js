// API Key 的签发、查询与撤销。
//
// 设计要点:**Key 就是人员身份的载体**。签发时就把人员信息(姓名、工号、飞书
// open_id)写进这条记录,提交时直接取用 —— 不再在每次提交时去解析邮箱。
// 因此 "解析不到人" 只可能发生在签发环节,而那时应当直接报错让管理员修正。
//
// 存储:Workers KV(键 `key:<key_id>`),无需数据库,撤销即时生效。
// 记录字段:{ hash, member, member_id, open_id, enabled, created_at, revoked_at }

import { ValidationError } from './report.js';
import { sha256Hex } from './report.js';

const KEY_PREFIX = 'key:';

export function newKeyId() {
  return [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function newSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function readKey(env, keyId) {
  if (!env.KEYS || !keyId) return null;
  return env.KEYS.get(`${KEY_PREFIX}${keyId}`, 'json');
}

export async function writeKey(env, keyId, record) {
  if (!env.KEYS) throw new Error('未绑定 KV 命名空间 KEYS');
  await env.KEYS.put(`${KEY_PREFIX}${keyId}`, JSON.stringify(record));
}

/// 签发:先确定人员身份(必须有 open_id 或可解析的邮箱),再生成 Key。
export async function issueKey(env, feishu, { member_id, member, email, open_id }) {
  const memberId = String(member_id ?? '').trim();
  const memberName = String(member ?? '').trim();
  if (!memberId) throw new ValidationError('必须提供 member_id(工号或账号)');
  if (!memberName) throw new ValidationError('必须提供 member(姓名)');
  // member_id 会拼进飞书过滤条件 CurrentValue.[提交ID]="成员-日期" 并写进表格,
  // 含引号/反斜杠/控制字符会破坏过滤条件,必须在签发时就挡住。
  if (memberId.length > 64) throw new ValidationError('member_id 过长(最多 64 字符)');
  if (!/^[A-Za-z0-9._@-]+$/.test(memberId)) {
    throw new ValidationError('member_id 只能包含字母、数字、点、下划线、@ 与连字符');
  }
  if (memberName.length > 64) throw new ValidationError('member 过长(最多 64 字符)');

  let resolved = String(open_id ?? '').trim();
  if (!resolved) {
    const mail = String(email ?? '').trim();
    if (!mail) throw new ValidationError('必须提供 email 或 open_id,否则无法把「成员」列关联到飞书通讯录');
    const ids = await feishu.resolveOpenIds(env, [mail], []);
    resolved = ids[mail] ?? '';
    if (!resolved) {
      throw new ValidationError(
        `无法把邮箱 ${mail} 解析为 open_id:请确认该邮箱属于本企业成员,且应用已开通 contact:user.id:readonly 并重新发布版本`,
      );
    }
  }

  const keyId = newKeyId();
  const secret = newSecret();
  const record = {
    hash: await sha256Hex(secret),
    member: memberName,
    member_id: memberId,
    open_id: resolved,
    enabled: true,
    created_at: new Date().toISOString(),
    revoked_at: null,
    // 只留末 4 位用于列表里做掩码显示;它不是可用凭据,也拼不出完整密钥。
    // 完整明文只在签发那一刻返回一次,服务端不留。
    secret_tail: secret.slice(-4),
  };
  await writeKey(env, keyId, record);
  return {
    key: `dag_${keyId}_${secret}`, // 只在这里返回一次
    key_id: keyId,
    member: memberName,
    member_id: memberId,
    open_id: resolved,            // 供台账写入使用(管理端接口,不是敏感信息)
    open_id_suffix: resolved.slice(-6),
  };
}

/// 作废某人现有的全部有效 Key,返回被作废的 key_id 列表。
///
/// 规则:**一个成员同时只有一把有效 Key**。成员重复提交表单时,新 Key 生效、旧的立即失效
/// —— 否则每提交一次就多留一把永久有效的凭证。历史记录保留在台账里(状态=已撤销)。
export async function revokeExistingFor(env, open_id, exceptKeyId = '') {
  if (!env.KEYS || !open_id) return [];
  const listed = await env.KEYS.list({ prefix: KEY_PREFIX });
  const revoked = [];
  for (const item of listed.keys ?? []) {
    const keyId = item.name.slice(KEY_PREFIX.length);
    if (keyId === exceptKeyId) continue;
    const record = await env.KEYS.get(item.name, 'json');
    if (!record || record.open_id !== open_id || record.enabled === false) continue;
    record.enabled = false;
    record.revoked_at = new Date().toISOString();
    await env.KEYS.put(item.name, JSON.stringify(record));
    revoked.push(keyId);
  }
  return revoked;
}

/// 掩码显示:首(dag_<key_id>_)与尾(末 4 位)可见,中间打星号。
/// 密钥本体不可还原 —— 服务端只有哈希和这 4 位。
export function maskedKey(keyId, secretTail) {
  const tail = secretTail ? String(secretTail) : '';
  return `dag_${keyId}_${'*'.repeat(8)}${tail}`;
}

/// 列出所有 Key(绝不返回哈希与明文)。
export async function listKeys(env) {
  if (!env.KEYS) return [];
  const listed = await env.KEYS.list({ prefix: KEY_PREFIX });
  const out = [];
  for (const item of listed.keys ?? []) {
    const record = await readKey(env, item.name.slice(KEY_PREFIX.length));
    if (!record) continue;
    out.push({
      key_id: item.name.slice(KEY_PREFIX.length),
      member: record.member,
      member_id: record.member_id,
      // open_id 用于把 Key 关联回员工列表(仅本机管理侧使用,不是敏感信息)
      open_id: record.open_id ?? '',
      masked: maskedKey(item.name.slice(KEY_PREFIX.length), record.secret_tail),
      linked: Boolean(record.open_id),
      enabled: record.enabled !== false,
      created_at: record.created_at ?? null,
      revoked_at: record.revoked_at ?? null,
    });
  }
  return out.sort((a, b) => String(a.member_id).localeCompare(String(b.member_id)));
}

/// 撤销:保留记录(便于审计),把 enabled 置为 false;鉴权随即失败。
export async function revokeKey(env, keyId) {
  const record = await readKey(env, keyId);
  if (!record) throw new ValidationError(`Key 不存在:${keyId}`);
  record.enabled = false;
  record.revoked_at = new Date().toISOString();
  await writeKey(env, keyId, record);
  return { key_id: keyId, member: record.member, member_id: record.member_id, revoked_at: record.revoked_at };
}
