// HTTP 路由与业务逻辑。
//
// 所有飞书访问都通过注入的 feishu 客户端进行,因此这一层可以在没有 Worker 运行时、
// 没有网络的情况下用假客户端完整测试(见 workers/test/handler.test.js)。

import { authenticate, authenticateAdmin, AuthError } from './auth.js';
import {
  ValidationError, validatePayload, contentFingerprint, toRows, FIELDS, FIELD_DEFS,
  REPORT_DATE, MAX_BODY_BYTES,
} from './report.js';
import * as realFeishu from './feishu.js';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: JSON_HEADERS });
}

function errorResponse(err) {
  const status = err.status ?? (err instanceof ValidationError ? 422 : 500);
  const code = err.code ?? (err instanceof ValidationError ? 'validation_failed' : 'internal_error');
  const body = { error: { code, message: err.message } };
  if (err.logId) body.error.log_id = err.logId;
  return json(body, status);
}

/// 提交日报:按「成员+日期」覆盖已存在的行,内容完全相同时幂等返回。
/// 任何写表失败都会抛出,绝不在表格未写入时返回 2xx(需求 FR-7.2/7.7)。
export async function submitDigest(request, env, feishu, now) {
  const member = await authenticate(request, env);

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) throw new ValidationError('请求体过大');
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    const err = new ValidationError('请求体不是合法 JSON');
    err.status = 400;
    err.code = 'invalid_json';
    throw err;
  }

  const report = validatePayload(body);
  const fingerprint = await contentFingerprint(report);
  const submitId = `${member.member_id}-${report.date}`;

  // 成员是「人员」字段:把邮箱解析成 open_id(需要 contact:user.id:readonly)。
  // 解析失败不影响提交,只是这一列为空,并在返回里标出 member_linked=false。
  let openId = member.open_id;
  if (!openId && member.email) {
    try {
      const resolved = await feishu.resolveOpenIds(env, [member.email], []);
      openId = resolved[member.email] ?? '';
    } catch (err) {
      console.warn(`open_id 解析失败(成员字段将留空):${err.message}`);
    }
  }
  const linkedMember = { ...member, open_id: openId };
  const rows = toRows(report, linkedMember, submitId, fingerprint, now());
  const existing = await feishu.findRecordsBySubmitId(env, submitId);

  const meta = {
    submission_id: `sub_${crypto.randomUUID()}`,
    member: member.member,
    member_id: member.member_id,
    member_linked: Boolean(openId),
    date: report.date,
    submitted_at: new Date(now()).toISOString(),
  };

  if (existing.length === rows.length && existing.length > 0) {
    const unchanged = existing.every(
      (record) => String(record.fields?.[FIELDS.fingerprint] ?? '') === fingerprint,
    );
    if (unchanged) {
      return json({ ...meta, mode: 'unchanged', records: existing.map((r, i) => ({ index: i, record_id: r.record_id })) }, 200);
    }
  }

  // 覆盖:逐行更新,工作项变少时删除多余的行,变多时补建。
  // 中途失败也不要紧:重试时会长到同一个 fingerprint,下一次调用会把状态收敛到目标。
  const updateCount = Math.min(existing.length, rows.length);
  const updates = rows.slice(0, updateCount).map((row, index) => ({
    record_id: existing[index].record_id,
    fields: row.fields,
  }));
  const creates = rows.slice(updateCount);
  const surplus = existing.slice(rows.length).map((record) => record.record_id);

  if (updates.length) await feishu.batchUpdate(env, updates);
  const created = creates.length ? await feishu.batchCreate(env, creates) : [];
  if (surplus.length) await feishu.batchDelete(env, surplus);

  const records = [
    ...updates.map((row, index) => ({ index, record_id: row.record_id })),
    ...created.map((row, index) => ({ index: updateCount + index, record_id: row.record_id })),
  ];
  return json({ ...meta, mode: existing.length ? 'updated' : 'created', records }, existing.length ? 200 : 201);
}

export async function whoami(request, env) {
  const member = await authenticate(request, env);
  return json({ member: member.member, member_id: member.member_id, key_id: member.key_id });
}

export async function queryDigest(request, env, feishu, url) {
  const member = await authenticate(request, env);
  const date = url.searchParams.get('date') ?? '';
  if (!REPORT_DATE.test(date)) throw new ValidationError('date 必须是 YYYY-MM-DD');
  const submitId = `${member.member_id}-${date}`;
  const existing = await feishu.findRecordsBySubmitId(env, submitId);
  return json({
    member: member.member,
    member_id: member.member_id,
    date,
    submitted: existing.length > 0,
    count: existing.length,
    fingerprint: existing[0]?.fields?.[FIELDS.fingerprint] ?? null,
  });
}

/// 管理员一次性建表 + 建字段,返回 table_id 供写入 Cloudflare vars。
export async function bootstrap(request, env, feishu) {
  authenticateAdmin(request, env);
  if (!env.BITABLE_APP_TOKEN) throw new ValidationError('缺少 BITABLE_APP_TOKEN');
  const tableName = env.BITABLE_TABLE_NAME || '日报明细';
  const created = [];
  const existingFields = [];

  let tableId = env.BITABLE_TABLE_ID;
  if (!tableId) {
    const tables = await feishu.listTables(env);
    const found = tables.find((table) => table.name === tableName);
    tableId = found ? found.table_id : await feishu.createTable(env, {
      name: tableName,
      fields: [{ field_name: FIELDS.submitId, type: 1 }],
    });
    if (!found) created.push(`table:${tableName}`);
  }

  const scoped = { ...env, BITABLE_TABLE_ID: tableId };
  const current = await feishu.listFields(scoped);
  const byName = new Map(current.map((field) => [field.field_name, field]));
  // 历史遗留:成员曾是文本字段,现在必须是人员字段(关联通讯录)。
  const legacyMember = byName.get(FIELDS.member);
  if (legacyMember && legacyMember.type !== 11) {
    const renamed = `${FIELDS.member}文本`;
    await feishu.updateField(scoped, legacyMember.field_id, { field_name: renamed, type: legacyMember.type });
    byName.delete(FIELDS.member);
    byName.set(renamed, { ...legacyMember, field_name: renamed });
    created.push(`renamed:${FIELDS.member}->${renamed}`);
  }
  const present = new Set(byName.keys());
  for (const definition of FIELD_DEFS) {
    if (present.has(definition.field_name)) {
      existingFields.push(definition.field_name);
      continue;
    }
    await feishu.createField(scoped, definition);
    created.push(`field:${definition.field_name}`);
  }

  return json({
    app_token: env.BITABLE_APP_TOKEN,
    table_id: tableId,
    table_name: tableName,
    created,
    existing_fields: existingFields,
    next_step: `把 BITABLE_TABLE_ID="${tableId}" 写入 wrangler.toml 的 [vars] 后重新部署`,
  });
}

export async function healthz(env, feishu) {
  try {
    await feishu.healthcheck(env);
    return json({ status: 'ok', table_configured: Boolean(env.BITABLE_TABLE_ID) });
  } catch (err) {
    return json({ status: 'degraded', message: err.message }, 503);
  }
}

/// Worker 入口。`deps` 仅用于测试注入(feishu 客户端与时钟)。
export async function handleRequest(request, env, deps = {}) {
  const feishu = deps.feishu ?? realFeishu;
  const now = deps.now ?? (() => Date.now());
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname}`;

  try {
    switch (route) {
      case 'GET /healthz':
        return await healthz(env, feishu);
      case 'GET /api/v1/me':
        return await whoami(request, env);
      case 'GET /api/v1/digests':
        return await queryDigest(request, env, feishu, url);
      case 'POST /api/v1/digests':
        return await submitDigest(request, env, feishu, now);
      case 'POST /admin/bootstrap':
        return await bootstrap(request, env, feishu);
      default:
        return json({ error: { code: 'not_found', message: `未知接口:${route}` } }, 404);
    }
  } catch (err) {
    if (err instanceof AuthError || err instanceof ValidationError || err.status) return errorResponse(err);
    // 未预期的异常也不能泄露堆栈
    return errorResponse(err);
  }
}
