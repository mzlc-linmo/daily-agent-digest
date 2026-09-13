// 飞书多维表格客户端。
//
// tenant_access_token 约 2 小时有效,缓存在模块级变量里(Worker 的热 isolate 会复用);
// 冷启动时重新获取。3–10 人的量级下,即便每次重取也远低于飞书的限额。
//
// 所有调用都必须检查响应体里的 `code`:飞书经常在 HTTP 200 下返回业务错误。

const FEISHU_BASE = 'https://open.feishu.cn/open-apis';
const TOKEN_EARLY_REFRESH_MS = 5 * 60 * 1000;

export class FeishuError extends Error {
  constructor(message, { status = 502, code = 'bitable_unavailable', logId = '' } = {}) {
    super(message);
    this.name = 'FeishuError';
    this.status = status;
    this.bitableCode = code;
    this.logId = logId;
  }
}

let cachedToken = null; // { value, expiresAt }
let inflightToken = null;

export function __resetTokenCache() {
  cachedToken = null;
  inflightToken = null;
}

async function requestToken(env) {
  const res = await fetch(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
  });
  const body = await res.json().catch(() => ({}));
  if (body.code !== 0 || !body.tenant_access_token) {
    throw new FeishuError(`获取 tenant_access_token 失败:${body.msg ?? res.status}`, {
      status: 503,
      code: 'not_ready',
    });
  }
  cachedToken = {
    value: body.tenant_access_token,
    expiresAt: Date.now() + Math.max(60, body.expire ?? 7200) * 1000 - TOKEN_EARLY_REFRESH_MS,
  };
  return cachedToken.value;
}

async function tenantToken(env, { force = false } = {}) {
  if (!force && cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
  if (!inflightToken) {
    inflightToken = requestToken(env).finally(() => {
      inflightToken = null;
    });
  }
  return inflightToken;
}

async function call(env, path, { method = 'GET', body, query, retryOnAuth = true } = {}) {
  const url = new URL(`${FEISHU_BASE}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const token = await tenantToken(env);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  const logId = res.headers.get('X-Tt-Logid') ?? payload?.error?.log_id ?? '';

  // token 失效:强制刷新一次再重试
  if (retryOnAuth && (res.status === 401 || payload.code === 99991663)) {
    await tenantToken(env, { force: true });
    return call(env, path, { method, body, query, retryOnAuth: false });
  }
  if (payload.code !== 0) {
    throw new FeishuError(`飞书接口失败:${path} code=${payload.code} msg=${payload.msg}`, { logId });
  }
  return payload.data ?? {};
}

/// 用 filter 查找某天某成员已有的行(幂等的关键)。
export async function findRecordsBySubmitId(env, submitId) {
  const items = [];
  let pageToken = '';
  do {
    const data = await call(env, `/bitable/v1/apps/${env.BITABLE_APP_TOKEN}/tables/${env.BITABLE_TABLE_ID}/records`, {
      query: { filter: `CurrentValue.[提交ID]="${submitId}"`, page_size: 500, page_token: pageToken || undefined },
    });
    items.push(...(data.items ?? []));
    pageToken = data.has_more ? data.page_token : '';
  } while (pageToken);
  return items;
}

export async function batchCreate(env, rows) {
  const created = [];
  for (let i = 0; i < rows.length; i += 500) {
    const data = await call(env, `/bitable/v1/apps/${env.BITABLE_APP_TOKEN}/tables/${env.BITABLE_TABLE_ID}/records/batch_create`, {
      method: 'POST',
      body: { records: rows.slice(i, i + 500) },
    });
    created.push(...(data.records ?? []));
  }
  return created;
}

export async function batchUpdate(env, records) {
  const updated = [];
  for (let i = 0; i < records.length; i += 500) {
    const data = await call(env, `/bitable/v1/apps/${env.BITABLE_APP_TOKEN}/tables/${env.BITABLE_TABLE_ID}/records/batch_update`, {
      method: 'POST',
      body: { records: records.slice(i, i + 500) },
    });
    updated.push(...(data.records ?? []));
  }
  return updated;
}

export async function batchDelete(env, recordIds) {
  for (let i = 0; i < recordIds.length; i += 500) {
    await call(env, `/bitable/v1/apps/${env.BITABLE_APP_TOKEN}/tables/${env.BITABLE_TABLE_ID}/records/batch_delete`, {
      method: 'POST',
      body: { records: recordIds.slice(i, i + 500) },
    });
  }
}

export async function listFields(env) {
  const data = await call(env, `/bitable/v1/apps/${env.BITABLE_APP_TOKEN}/tables/${env.BITABLE_TABLE_ID}/fields`, {
    query: { page_size: 200 },
  });
  return data.items ?? [];
}

export async function updateField(env, fieldId, body) {
  return call(env, `/bitable/v1/apps/${env.BITABLE_APP_TOKEN}/tables/${env.BITABLE_TABLE_ID}/fields/${fieldId}`, {
    method: 'PUT',
    body,
  });
}

/// 把邮箱/手机号解析成 open_id(同一应用内有效)。结果按输入缓存,避免每次提交都查。
const userIdCache = new Map();

export function __resetUserIdCache() {
  userIdCache.clear();
}

export async function resolveOpenIds(env, emails = [], mobiles = []) {
  const missing = [...emails, ...mobiles].filter((key) => key && !userIdCache.has(key));
  if (missing.length) {
    const data = await call(env, '/contact/v3/users/batch_get_id', {
      method: 'POST',
      query: { user_id_type: 'open_id' },
      body: { emails, mobiles },
    });
    for (const entry of data.user_list ?? []) {
      const openId = entry.user_id ?? entry.open_id ?? '';
      for (const key of [entry.email, entry.mobile]) {
        if (key) userIdCache.set(key, openId);
      }
    }
    for (const key of missing) if (!userIdCache.has(key)) userIdCache.set(key, '');
  }
  const resolved = {};
  for (const key of [...emails, ...mobiles]) if (key) resolved[key] = userIdCache.get(key) ?? '';
  return resolved;
}

export async function createField(env, field) {
  return call(env, `/bitable/v1/apps/${env.BITABLE_APP_TOKEN}/tables/${env.BITABLE_TABLE_ID}/fields`, {
    method: 'POST',
    body: field,
  });
}

export async function createTable(env, { name, fields }) {
  const data = await call(env, `/bitable/v1/apps/${env.BITABLE_APP_TOKEN}/tables`, {
    method: 'POST',
    body: { table: { name, default_view_name: '表格', fields } },
  });
  return data.table_id ?? data.table?.table_id;
}

export async function listTables(env) {
  const data = await call(env, `/bitable/v1/apps/${env.BITABLE_APP_TOKEN}/tables`, { query: { page_size: 100 } });
  return data.items ?? [];
}

/// 供 /healthz 使用:确认能拿到 token 且表可读。
export async function healthcheck(env) {
  await tenantToken(env, { force: true });
  return true;
}
