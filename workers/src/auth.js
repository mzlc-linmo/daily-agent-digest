// API Key 鉴权。
//
// Key 格式:`dag_<key_id>_<secret>`。服务端只保存 `sha256(secret)`,明文只发给成员一次。
// 成员身份完全由 Key 推导 —— 请求体里的任何成员字段都不采信,避免冒名提交。
//
// 配置(Cloudflare vars,JSON 字符串):
//   API_KEYS = {"k_abcd1234": {"hash":"<sha256(secret) 的十六进制>","member":"张三",
//                              "member_id":"zhangsan","enabled":true}}
//   ADMIN_TOKEN = 用于 /admin/bootstrap 的管理口令(建议用 secret 而非 vars)

import { sha256Hex, timingSafeEqualHex } from './report.js';

export class AuthError extends Error {
  constructor(message, status = 401, code = 'invalid_key') {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
  }
}

export function loadKeys(env) {
  const raw = env.API_KEYS;
  if (!raw) throw new Error('缺少环境变量 API_KEYS');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`API_KEYS 不是合法 JSON:${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('API_KEYS 必须是对象');
  return parsed;
}

export function parseKey(presented) {
  if (typeof presented !== 'string') return null;
  const match = /^dag_([A-Za-z0-9]+)_(.+)$/.exec(presented.trim());
  if (!match) return null;
  return { keyId: match[1], secret: match[2] };
}

/// 校验请求头里的 Key,返回成员信息。任何失败都抛 AuthError。
export async function authenticate(request, env) {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : request.headers.get('X-API-Key');
  const parsed = parseKey(token);
  if (!parsed) throw new AuthError('缺少或格式错误的 API Key');

  const keys = loadKeys(env);
  const entry = keys[parsed.keyId];
  if (!entry) throw new AuthError('API Key 不存在');

  const digest = await sha256Hex(parsed.secret);
  if (!timingSafeEqualHex(digest, String(entry.hash ?? ''))) {
    throw new AuthError('API Key 不正确');
  }
  if (entry.enabled === false) {
    throw new AuthError('成员已停用', 403, 'member_disabled');
  }
  return {
    key_id: parsed.keyId,
    member: String(entry.member ?? parsed.keyId),
    member_id: String(entry.member_id ?? parsed.keyId),
  };
}

/// 管理员口令校验(bootstrap 用)。
export function authenticateAdmin(request, env) {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expected = env.ADMIN_TOKEN;
  if (!expected) throw new AuthError('未配置 ADMIN_TOKEN', 503, 'not_ready');
  if (!timingSafeEqualHex(token, expected)) throw new AuthError('管理口令不正确', 401, 'invalid_admin_token');
}

/// 生成一把新 Key(管理员本地使用,不经过服务端):
///   node workers/scripts/new-key.mjs zhangsan 张三
export async function makeKeyEntry(secret) {
  return sha256Hex(secret);
}
