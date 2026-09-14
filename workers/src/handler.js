// HTTP 路由与业务逻辑。
//
// 所有飞书访问都通过注入的 feishu 客户端进行,因此这一层可以在没有 Worker 运行时、
// 没有网络的情况下用假客户端完整测试(见 workers/test/handler.test.js)。

import { authenticate, AuthError } from './auth.js';
import {
  ValidationError, validatePayload, contentFingerprint, toRows, FIELDS, FIELD_DEFS,
  REPORT_DATE, MAX_BODY_BYTES,
} from './report.js';
import * as realFeishu from './feishu.js';
import { logEvent, requestContext } from './logs.js';

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), { status, headers: JSON_HEADERS });
}

/// 只有我们自己写出来的错误信息(校验/鉴权)才回显给客户端。
/// 上游(飞书)与未预期异常的信息可能包含内部路径、参数甚至凭据片段,一律换成通用文案,
/// 细节只写服务端日志 —— 客户端仍可通过 log_id 让管理员查证。
function errorResponse(err) {
  const expected = err instanceof ValidationError || err instanceof AuthError;
  const status = err.status ?? (err instanceof ValidationError ? 422 : 500);
  const code = err.code ?? (err instanceof ValidationError ? 'validation_failed' : 'internal_error');
  if (!expected) console.error(`请求失败(${code}):${err?.stack ?? err}`);
  const body = { error: { code, message: expected ? err.message : '服务内部错误,请稍后重试' } };
  if (err.logId) body.error.log_id = err.logId;
  return json(body, status);
}

/// 提交日报:按「成员+日期」覆盖已存在的行,内容完全相同时幂等返回。
/// 任何写表失败都会抛出,绝不在表格未写入时返回 2xx(需求 FR-7.2/7.7)。
export async function submitDigest(request, env, feishu, now, audit = {}) {
  const member = await authenticate(request, env);

  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY_BYTES) throw new ValidationError('请求体过大');
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

  // 身份在签发 Key 时就已绑定,这里直接取用;唯一会失败的情况是 Key 被撤销(已在鉴权阶段拦截)。
  const openId = member.open_id;
  if (!openId) console.warn(`Key ${member.key_id} 未绑定 open_id,「成员」列将留空`);
  const rows = toRows(report, { ...member, open_id: openId }, submitId, fingerprint, now());
  const existing = await feishu.findRecords(env, env.BITABLE_TABLE_ID, `CurrentValue.[提交ID]="${submitId}"`);

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

  if (updates.length) await feishu.batchUpdate(env, env.BITABLE_TABLE_ID, updates);
  const created = creates.length ? await feishu.batchCreate(env, env.BITABLE_TABLE_ID, creates) : [];
  if (surplus.length) await feishu.batchDelete(env, env.BITABLE_TABLE_ID, surplus);

  const records = [
    ...updates.map((row, index) => ({ index, record_id: row.record_id })),
    ...created.map((row, index) => ({ index: updateCount + index, record_id: row.record_id })),
  ];
  const mode = existing.length ? 'updated' : 'created';
  await logEvent(env, {
    ...audit,
    event: 'submit',
    outcome: 'ok',
    duration_ms: (audit.started ? now() - audit.started : null),
    key_id: member.key_id,
    member: member.member,
    member_id: member.member_id,
    date: report.date,
    mode,
    items: report.items.length,
    // 注意:validatePayload 返回的是 camelCase(曾在这里写成 snake_case,导致这两个字段恒为 null)
    report_chars: report.reportChars,
    release_version: report.releaseVersion || null,
    detail: JSON.stringify({ coverage_note: report.coverageNote }),
  });
  return json({ ...meta, mode, records }, existing.length ? 200 : 201);
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
  const existing = await feishu.findRecords(env, env.BITABLE_TABLE_ID, `CurrentValue.[提交ID]="${submitId}"`);
  return json({
    member: member.member,
    member_id: member.member_id,
    date,
    submitted: existing.length > 0,
    count: existing.length,
    fingerprint: existing[0]?.fields?.[FIELDS.fingerprint] ?? null,
  });
}

export async function healthz(env, feishu) {
  try {
    await feishu.healthcheck(env);
    return json({ status: 'ok', table_configured: Boolean(env.BITABLE_TABLE_ID) });
  } catch (err) {
    // 未鉴权接口:只回状态,细节不暴露(便于支持:仍给 log_id)
    console.error(`healthz 失败:${err?.message ?? err}`);
    const body = { status: 'degraded' };
    if (err.logId) body.log_id = err.logId;
    return json(body, 503);
  }
}

/// Worker 入口。`deps` 仅用于测试注入(feishu 客户端与时钟)。
export async function handleRequest(request, env, deps = {}) {
  const feishu = deps.feishu ?? realFeishu;
  const now = deps.now ?? (() => Date.now());
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname}`;
  // 审计上下文:失败也要留痕,所以放在 try 外面
  const audit = { ...requestContext(request), started: now() };
  const auditEvent = route === 'POST /api/v1/digests' ? 'submit' : null;

  try {
    switch (route) {
      case 'GET /healthz':
        return await healthz(env, feishu);
      case 'GET /api/v1/me':
        return await whoami(request, env);
      case 'GET /api/v1/digests':
        return await queryDigest(request, env, feishu, url);
      case 'POST /api/v1/digests':
        return await submitDigest(request, env, feishu, now, audit);
      default:
        // 管理接口已彻底移除:公网不暴露任何管理入口。
        // 管理动作(建表/发 Key/撤销/查日志)由本机 CLI 直连 KV/D1/飞书完成。
        return json({ error: { code: 'not_found', message: '未知接口' } }, 404);
    }
  } catch (err) {
    const response = errorResponse(err);
    if (auditEvent) {
      await logEvent(env, {
        ...audit,
        event: auditEvent,
        outcome: 'error',
        duration_ms: now() - audit.started,
        error_code: err.code ?? (err instanceof ValidationError ? 'validation_failed' : 'internal_error'),
        error_message: String(err.message ?? err).slice(0, 500),
      });
    }
    return response;
  }
}
