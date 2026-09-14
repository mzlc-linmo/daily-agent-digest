// 飞书多维表格客户端。
//
// tenant_access_token 约 2 小时有效,缓存在模块级变量里(Worker 的热 isolate 会复用);
// 冷启动时重新获取。3–10 人的量级下,即便每次重取也远低于飞书的限额。
//
// 所有调用都必须检查响应体里的 `code`:飞书经常在 HTTP 200 下返回业务错误。

// 默认官方地址。本地联调/测试可用 FEISHU_BASE_URL 指到桩服务;
// Cloudflare 运行时里没有 process,所以走 globalThis 兜底而不是直接引用。
const FEISHU_BASE = globalThis.process?.env?.FEISHU_BASE_URL ?? 'https://open.feishu.cn/open-apis';
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

/// 按 filter 查找已有的行(幂等的关键)。tableId 必须显式传入。
export async function findRecords(env, tableId, filter) {
  if (!tableId) throw new Error('缺少 tableId');
  const table = tableId;
  const items = [];
  let pageToken = '';
  do {
    const data = await call(env, `/bitable/v1/apps/${env.BITABLE_APP_TOKEN}/tables/${table}/records`, {
      query: { filter, page_size: 500, page_token: pageToken || undefined },
    });
    items.push(...(data.items ?? []));
    pageToken = data.has_more ? data.page_token : '';
  } while (pageToken);
  return items;
}

export async function batchCreate(env, tableId, rows) {
  if (!tableId) throw new Error('缺少 tableId');
  const table = tableId;
  const created = [];
  for (let i = 0; i < rows.length; i += 500) {
    const data = await call(env, `/bitable/v1/apps/${env.BITABLE_APP_TOKEN}/tables/${table}/records/batch_create`, {
      method: 'POST',
      body: { records: rows.slice(i, i + 500) },
    });
    created.push(...(data.records ?? []));
  }
  return created;
}

export async function batchUpdate(env, tableId, records) {
  if (!tableId) throw new Error('缺少 tableId');
  const table = tableId;
  const updated = [];
  for (let i = 0; i < records.length; i += 500) {
    const data = await call(env, `/bitable/v1/apps/${env.BITABLE_APP_TOKEN}/tables/${table}/records/batch_update`, {
      method: 'POST',
      body: { records: records.slice(i, i + 500) },
    });
    updated.push(...(data.records ?? []));
  }
  return updated;
}

export async function batchDelete(env, tableId, recordIds) {
  if (!tableId) throw new Error('缺少 tableId');
  const table = tableId;
  for (let i = 0; i < recordIds.length; i += 500) {
    await call(env, `/bitable/v1/apps/${env.BITABLE_APP_TOKEN}/tables/${table}/records/batch_delete`, {
      method: 'POST',
      body: { records: recordIds.slice(i, i + 500) },
    });
  }
}

/// tableId 必须显式传入 —— 不再回退到主表,避免"字段建错表"这种静默错误。
export async function listFields(env, tableId) {
  if (!tableId) throw new Error('listFields 缺少 tableId');
  const data = await call(env, `/bitable/v1/apps/${env.BITABLE_APP_TOKEN}/tables/${tableId}/fields`, {
    query: { page_size: 200 },
  });
  return data.items ?? [];
}

export async function updateField(env, fieldId, body, tableId) {
  if (!tableId) throw new Error('updateField 缺少 tableId');
  return call(env, `/bitable/v1/apps/${env.BITABLE_APP_TOKEN}/tables/${tableId}/fields/${fieldId}`, {
    method: 'PUT',
    body,
  });
}

/// 把邮箱/手机号解析成 open_id(同一应用内有效)。结果按输入缓存,避免每次提交都查。
const userIdCache = new Map();

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

export async function createField(env, field, tableId) {
  if (!tableId) throw new Error('createField 缺少 tableId');
  return call(env, `/bitable/v1/apps/${env.BITABLE_APP_TOKEN}/tables/${tableId}/fields`, {
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

/// 知识库(Wiki)里的多维表格:链接给的是 node_token,不是 app_token。
/// 本地 CLI 收到 /wiki/<node_token> 形式的地址时用它换算成真正的 app_token。
export async function resolveWikiNode(env, nodeToken) {
  const data = await call(env, '/wiki/v2/spaces/get_node', { query: { token: nodeToken, obj_type: 'wiki' } });
  const node = data.node ?? {};
  return { objToken: node.obj_token ?? '', objType: node.obj_type ?? '', title: node.title ?? '' };
}

/// 供 /healthz 使用:确认能拿到 token 且表可读。
export async function healthcheck(env) {
  await tenantToken(env, { force: true });
  return true;
}
