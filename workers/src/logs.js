// D1 审计日志:写入与查询。
//
// 写入一律 best-effort —— 日志服务出问题绝不能影响成员提交日报。
// 没绑定 DB 时全部静默跳过,方便本地/未启用 D1 的部署照常工作。

const COLUMNS = [
  'ts', 'event', 'request_id', 'key_id', 'member', 'member_id', 'date', 'mode',
  'items', 'report_chars', 'duration_ms', 'outcome', 'error_code', 'error_message',
  'release_version', 'user_agent', 'country', 'detail',
];

/// 单列长度上限:审计字段大多来自客户端(UA、版本号等),
/// 不设限就能被用来把 D1 撑大。
const LIMITS = {
  member: 64, member_id: 64, key_id: 32, date: 10, mode: 16, outcome: 16,
  error_code: 64, error_message: 500, release_version: 64, user_agent: 200,
  country: 8, request_id: 64, detail: 2000,
};

export async function logEvent(env, event) {
  if (!env || !env.DB) return false;
  const row = { ts: new Date().toISOString(), outcome: 'ok', ...event };
  for (const [key, max] of Object.entries(LIMITS)) {
    if (typeof row[key] === 'string' && row[key].length > max) row[key] = row[key].slice(0, max);
  }
  try {
    await env.DB
      .prepare(`INSERT INTO audit_log (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`)
      .bind(...COLUMNS.map((c) => (row[c] === undefined ? null : row[c])))
      .run();
    return true;
  } catch (err) {
    console.warn(`审计日志写入失败:${err.message}`);
    return false;
  }
}

/// 从请求里提取审计需要的上下文。
export function requestContext(request) {
  return {
    request_id: crypto.randomUUID(),
    user_agent: request.headers.get('User-Agent') ?? null,
    country: request.cf?.country ?? null,
  };
}

/// 查询日志(管理员接口用)。
export async function queryLogs(env, { limit = 100, memberId, date, event, outcome } = {}) {
  if (!env || !env.DB) throw new Error('未绑定 D1 数据库(DB)');
  const where = [];
  const params = [];
  if (memberId) { where.push('member_id = ?'); params.push(memberId); }
  if (date) { where.push('date = ?'); params.push(date); }
  if (event) { where.push('event = ?'); params.push(event); }
  if (outcome) { where.push('outcome = ?'); params.push(outcome); }
  const size = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  const sql = `SELECT ${COLUMNS.join(', ')} FROM audit_log`
    + (where.length ? ` WHERE ${where.join(' AND ')}` : '')
    + ' ORDER BY id DESC LIMIT ?';
  const result = await env.DB.prepare(sql).bind(...params, size).all();
  return result.results ?? [];
}

/// 保留策略:删除超过 retainDays 天的日志(定时任务里调用)。
export async function pruneLogs(env, retainDays = 180) {
  if (!env || !env.DB) return 0;
  const cutoff = new Date(Date.now() - retainDays * 86400_000).toISOString();
  try {
    const result = await env.DB.prepare('DELETE FROM audit_log WHERE ts < ?').bind(cutoff).run();
    return result.meta?.changes ?? 0;
  } catch (err) {
    console.warn(`日志清理失败:${err.message}`);
    return 0;
  }
}
