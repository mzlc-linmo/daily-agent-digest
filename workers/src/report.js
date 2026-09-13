// 日报提交服务:接口契约、字段定义与校验规则。
// 契约见 docs/backend-design.md 第 4 节。

export const REPORT_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const STATUS_VALUES = ['completed', 'in_progress', 'blocked'];
export const MAX_ITEMS = 100;
export const MAX_TITLE = 200;
export const MAX_DESC = 4000;
export const MAX_BODY_BYTES = 512 * 1024;

// 多维表格字段名 —— 与 bootstrap 建表时使用的名字必须一致。
export const FIELDS = {
  submitId: '提交ID',
  date: '日期',
  member: '成员',
  memberId: '成员ID',
  title: '标题',
  desc: '内容',
  status: '状态',
  chars: '字数',
  sources: '来源',
  submittedAt: '提交时间',
  appVersion: '应用版本',
  fingerprint: '内容指纹',
};

// 飞书多维表格字段类型码:
// 1 多行文本 / 2 数字 / 3 单选 / 4 多选 / 5 日期 / 11 人员
// 日期类字段的值必须是毫秒时间戳。
export const FIELD_DEFS = [
  { field_name: FIELDS.submitId, type: 1 },
  { field_name: FIELDS.date, type: 5, property: { date_formatter: 'yyyy/MM/dd', auto_fill: false } },
  { field_name: FIELDS.member, type: 1 },
  { field_name: FIELDS.memberId, type: 1 },
  { field_name: FIELDS.title, type: 1 },
  { field_name: FIELDS.desc, type: 1 },
  { field_name: FIELDS.status, type: 3, property: { options: STATUS_VALUES.map((name) => ({ name })) } },
  { field_name: FIELDS.chars, type: 2, property: { formatter: '0' } },
  { field_name: FIELDS.sources, type: 4, property: { options: [] } },
  { field_name: FIELDS.submittedAt, type: 5, property: { date_formatter: 'yyyy/MM/dd HH:mm', auto_fill: false } },
  { field_name: FIELDS.appVersion, type: 1 },
  { field_name: FIELDS.fingerprint, type: 1 },
];

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

/// 去掉空白后的字符数,与引擎的 char_count() 保持一致。
export function charCount(text) {
  return String(text ?? '').replace(/\s+/g, '').length;
}

/// 校验并规范化提交载荷。返回 { date, generatedAt, releaseVersion, coverageNote, items }。
export function validatePayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('请求体必须是 JSON 对象');
  }
  const date = String(body.date ?? '');
  if (!REPORT_DATE.test(date)) throw new ValidationError('date 必须是 YYYY-MM-DD');

  const items = body.work_items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new ValidationError('work_items 不能为空');
  }
  if (items.length > MAX_ITEMS) {
    throw new ValidationError(`work_items 不能超过 ${MAX_ITEMS} 项`);
  }

  const normalized = items.map((item, index) => {
    if (!item || typeof item !== 'object') throw new ValidationError(`第 ${index + 1} 项不是对象`);
    const title = String(item.title ?? '').trim();
    if (!title) throw new ValidationError(`第 ${index + 1} 项缺少 title`);
    if (title.length > MAX_TITLE) throw new ValidationError(`第 ${index + 1} 项 title 过长`);
    const desc = String(item.desc ?? '');
    if (desc.length > MAX_DESC) throw new ValidationError(`第 ${index + 1} 项 desc 过长`);
    const status = String(item.status ?? 'completed');
    if (!STATUS_VALUES.includes(status)) throw new ValidationError(`第 ${index + 1} 项 status 非法`);
    const sources = Array.isArray(item.source_task_ids)
      ? [...new Set(item.source_task_ids.map((s) => String(s).split('/')[0]).filter(Boolean))]
      : [];
    return { title, desc, status, sources };
  });

  return {
    date,
    generatedAt: body.generated_at ? String(body.generated_at) : '',
    releaseVersion: body.release_version ? String(body.release_version) : '',
    coverageNote: body.coverage_note ? String(body.coverage_note) : '',
    reportChars: Number.isFinite(Number(body.report_chars)) ? Number(body.report_chars) : 0,
    items: normalized,
  };
}

/// 内容指纹:用于判断同一天重复提交是否完全一致(幂等)。
export async function contentFingerprint(report) {
  const canonical = JSON.stringify({
    items: report.items.map((i) => [i.title, i.desc, i.status]),
    chars: report.reportChars,
  });
  return sha256Hex(canonical);
}

export async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/// 恒定时间比较两个十六进制字符串,避免通过响应时间泄露密钥信息。
export function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/// 把校验后的报告转成多维表格行(一行一个工作项)。
export function toRows(report, member, submitId, fingerprint, submittedAtMs) {
  return report.items.map((item) => ({
    fields: {
      [FIELDS.submitId]: submitId,
      [FIELDS.date]: Date.parse(`${report.date}T00:00:00+08:00`),
      [FIELDS.member]: member.member,
      [FIELDS.memberId]: member.member_id,
      [FIELDS.title]: item.title,
      [FIELDS.desc]: item.desc,
      [FIELDS.status]: item.status,
      [FIELDS.chars]: charCount(item.title) + charCount(item.desc),
      ...(item.sources.length ? { [FIELDS.sources]: item.sources } : {}),
      [FIELDS.submittedAt]: submittedAtMs,
      [FIELDS.appVersion]: report.releaseVersion,
      [FIELDS.fingerprint]: fingerprint,
    },
  }));
}
