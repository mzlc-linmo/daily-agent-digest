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
import { readKey } from './keys.js';

export class AuthError extends Error {
  constructor(message, status = 401, code = 'invalid_key') {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
  }
}

/// 解析 `dag_<key_id>_<secret>`。格式不对返回 null。
export function parseKey(presented) {
  if (typeof presented !== 'string') return null;
  const match = /^dag_([A-Za-z0-9]+)_(.+)$/.exec(presented.trim());
  if (!match) return null;
  return { keyId: match[1], secret: match[2] };
}

/// 取出这位成员绑定的 Key 记录。
/// 优先读 KV(签发时已绑定人员);API_KEYS 变量仅作为旧部署的兼容回退。
export async function identify(presented, env) {
  const parsed = parseKey(presented);
  if (!parsed) return null;
  const fromKv = await readKey(env, parsed.keyId);
  if (fromKv) return { keyId: parsed.keyId, secret: parsed.secret, entry: fromKv };
  const legacy = legacyKeys(env)[parsed.keyId];
  return legacy ? { keyId: parsed.keyId, secret: parsed.secret, entry: legacy } : null;
}

function legacyKeys(env) {
  if (!env.API_KEYS) return {};
  try {
    const parsed = JSON.parse(env.API_KEYS);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/// 校验请求头里的 Key,返回成员身份(含签发时就绑定的 open_id)。
export async function authenticate(request, env) {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : request.headers.get('X-API-Key');
  const found = await identify(token, env);
  if (!found) throw new AuthError('缺少、格式错误或已失效的 API Key');

  const digest = await sha256Hex(found.secret);
  if (!timingSafeEqualHex(digest, String(found.entry.hash ?? ''))) {
    throw new AuthError('API Key 不正确');
  }
  if (found.entry.enabled === false) {
    throw new AuthError('该 API Key 已被撤销', 403, 'key_revoked');
  }
  return {
    key_id: found.keyId,
    member: String(found.entry.member ?? found.keyId),
    member_id: String(found.entry.member_id ?? found.keyId),
    open_id: String(found.entry.open_id ?? ''),
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


