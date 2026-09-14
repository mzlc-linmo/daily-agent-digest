// 飞书侧的两张管理表:
//   ① 「成员密钥」登记表 —— 签发/撤销/最近提交自动写入,团队可见、可审计
//   ② 「密钥申请」表     —— 成员用表单申请,管理员签发后自动回写状态
//
// 这两张表是给人和审计看的;鉴权仍然以 KV 为准(KV 是权威,表是台账)。
// 写入一律 best-effort:台账写失败不能影响成员提交日报。

export const REGISTRY = {
  name: '成员密钥',
  fields: {
    member: '成员',        // 人员(通讯录)
    memberId: '成员ID',
    keyId: 'KeyID',
    status: '状态',        // 单选:已启用 / 已撤销
    issuedAt: '签发时间',
    revokedAt: '撤销时间',
    lastSubmit: '最近提交',
    note: '备注',
  },
};

export const REQUESTS = {
  name: '密钥申请',
  fields: {
    title: '申请标题',      // 主字段:飞书的主字段不能用人员类型
    applicant: '申请人',    // 人员(通讯录)
    account: '账号',        // 工号/账号,用作 member_id
    remark: '申请说明',
    status: '状态',        // 单选:待处理 / 已签发 / 已撤销
    key: 'Key',            // 生成的明文 Key,写回该行,成员自己复制
    keyId: 'KeyID',
    handledAt: '处理时间',
  },
};

import { issueKey, revokeExistingFor } from './keys.js';

export const STATUS_ISSUED = '已启用';
export const STATUS_REVOKED = '已撤销';
export const REQUEST_PENDING = '待处理';
export const REQUEST_ISSUED = '已签发';
export const REQUEST_REVOKED = '已撤销';

export function registryFieldDefs() {
  const f = REGISTRY.fields;
  return [
    { field_name: f.keyId, type: 1 },
    { field_name: f.member, type: 11 },
    { field_name: f.memberId, type: 1 },
    { field_name: f.status, type: 3, property: { options: [{ name: STATUS_ISSUED }, { name: STATUS_REVOKED }] } },
    { field_name: f.issuedAt, type: 5, property: { date_formatter: 'yyyy/MM/dd HH:mm', auto_fill: false } },
    { field_name: f.revokedAt, type: 5, property: { date_formatter: 'yyyy/MM/dd HH:mm', auto_fill: false } },
    { field_name: f.lastSubmit, type: 5, property: { date_formatter: 'yyyy/MM/dd HH:mm', auto_fill: false } },
    { field_name: f.note, type: 1 },
  ];
}

export function requestFieldDefs() {
  const f = REQUESTS.fields;
  return [
    { field_name: f.title, type: 1 },      // 必须是文本,才能作为主字段
    { field_name: f.applicant, type: 11 },
    { field_name: f.remark, type: 1 },
    { field_name: f.status, type: 3, property: { options: [{ name: REQUEST_PENDING }, { name: REQUEST_ISSUED }, { name: '已拒绝' }] } },
    { field_name: f.keyId, type: 1 },
    { field_name: f.handledAt, type: 5, property: { date_formatter: 'yyyy/MM/dd HH:mm', auto_fill: false } },
  ];
}

/// 找到或创建一张表,并补齐缺失字段。返回 { tableId, created: [...] }。
export async function ensureTable(env, feishu, spec, defs) {
  const created = [];
  const tables = await feishu.listTables(env);
  let tableId = tables.find((t) => t.name === spec.name)?.table_id;
  if (!tableId) {
    tableId = await feishu.createTable(env, {
      name: spec.name,
      // 第一列是主字段,飞书只允许有限的类型(这里统一用文本);其余字段下面逐个补
      fields: [{ field_name: defs[0].field_name, type: defs[0].type, ...(defs[0].property ? { property: defs[0].property } : {}) }],
    });
    created.push(`table:${spec.name}`);
  }
  const present = new Set((await feishu.listFields(env, tableId)).map((f) => f.field_name));
  for (const def of defs) {
    if (present.has(def.field_name)) continue;
    await feishu.createField(env, def, tableId);
    created.push(`field:${spec.name}.${def.field_name}`);
  }
  return { tableId, created };
}

function ms(iso) {
  return Date.parse(iso || new Date().toISOString());
}

/// 定时任务:处理「密钥申请」表里待处理的行。
///
/// 成员填完表单,记录落到申请表;这里给它生成一把随机 Key、写回该行(成员自己复制),
/// 同时在登记表建一行。无需管理员介入 —— 表就是控制面:
///   · 状态=待处理 → 自动签发
///   · 状态=已撤销 → 撤销对应 Key
export async function processRequests(env, feishu) {
  if (!env.REQUEST_TABLE_ID) return { issued: 0, revoked: 0, skipped: 0 };
  const f = REQUESTS.fields;
  const rows = await feishu.findRecords(env, env.REQUEST_TABLE_ID, undefined);
  let issued = 0; let revoked = 0; let skipped = 0;

  for (const row of rows) {
    const fields = row.fields ?? {};
    const status = String(fields[f.status] ?? '');
    const keyId = String(fields[f.keyId] ?? '');
    const person = (fields[f.applicant] ?? [])[0];

    // 撤销:表里把状态改成「已撤销」即可
    if (status === REQUEST_REVOKED && keyId) {
      if (env.KEYS) {
        const record = await env.KEYS.get(`key:${keyId}`, 'json');
        if (record && record.enabled !== false) {
          record.enabled = false;
          record.revoked_at = new Date().toISOString();
          await env.KEYS.put(`key:${keyId}`, JSON.stringify(record));
        }
      }
      await recordRevoked(env, feishu, { key_id: keyId, revoked_at: new Date().toISOString() });
      revoked += 1;
      continue;
    }

    // 签发:还没拿到 Key 的申请。
    // 注意:表单里「状态」是隐藏字段,成员提交后这一列是空的 —— 空状态同样视为待处理,
    // 否则真实提交永远拿不到 Key。
    const alreadyIssued = Boolean(fields[f.key]) || Boolean(keyId) || status === REQUEST_ISSUED;
    if (alreadyIssued || status === REQUEST_REVOKED || !person?.id) { skipped += 1; continue; }
    const memberId = String(fields[f.account] ?? '').trim() || `u${String(person.id).slice(-6)}`;
    // 一人一把:作废该成员已有的有效 Key(重复提交不会留下多把永久凭证)
    for (const oldKeyId of await revokeExistingFor(env, person.id)) {
      await recordRevoked(env, feishu, { key_id: oldKeyId, revoked_at: new Date().toISOString() });
    }
    const issuedKey = await issueKey(env, feishu, {
      member_id: memberId,
      member: person.name || memberId,
      open_id: person.id,
    });
    await feishu.batchUpdate(env, env.REQUEST_TABLE_ID, [{
      record_id: row.record_id,
      fields: {
        [f.status]: REQUEST_ISSUED,
        [f.key]: issuedKey.key,
        [f.keyId]: issuedKey.key_id,
        [f.handledAt]: ms(new Date().toISOString()),
      },
    }]);
    await recordIssued(env, feishu, {
      member: issuedKey.member, member_id: issuedKey.member_id, key_id: issuedKey.key_id,
      open_id: issuedKey.open_id, created_at: new Date().toISOString(),
    });
    issued += 1;
  }
  return { issued, revoked, skipped };
}

/// 签发后登记一行(台账)。注意:申请表的"关单"由 processRequests 负责。
export async function recordIssued(env, feishu, { member, member_id, key_id, open_id, created_at }) {
  const notes = [];
  if (!env.REGISTRY_TABLE_ID) return notes;
  const f = REGISTRY.fields;
  await feishu.batchCreate(env, env.REGISTRY_TABLE_ID, [{
    fields: {
      [f.keyId]: key_id,
      ...(open_id ? { [f.member]: [{ id: open_id }] } : {}),
      [f.memberId]: member_id,
      [f.status]: STATUS_ISSUED,
      [f.issuedAt]: ms(created_at),
    },
  }]);
  notes.push('registry:created');
  // 管理员手动签发时,顺手关掉该成员待处理的申请;
  // 否则定时任务会给同一条申请再发一把 Key。
  // 注意:人员字段不能用 filter 匹配,按状态取回后在本地比对。
  if (env.REQUEST_TABLE_ID && open_id) {
    const rf = REQUESTS.fields;
    const pending = (await feishu.findRecords(env, env.REQUEST_TABLE_ID,
      `CurrentValue.[${rf.status}]="${REQUEST_PENDING}"`))
      .filter((r) => (r.fields?.[rf.applicant] ?? []).some((p) => p && p.id === open_id));
    if (pending.length) {
      await feishu.batchUpdate(env, env.REQUEST_TABLE_ID, pending.map((r) => ({
        record_id: r.record_id,
        fields: { [rf.status]: REQUEST_ISSUED, [rf.keyId]: key_id, [rf.handledAt]: ms(new Date().toISOString()) },
      })));
      notes.push(`requests:closed=${pending.length}`);
    }
  }
  return notes;
}

/// 撤销后更新登记行。
export async function recordRevoked(env, feishu, { key_id, revoked_at }) {
  if (!env.REGISTRY_TABLE_ID) return [];
  const f = REGISTRY.fields;
  const rows = await feishu.findRecords(env, env.REGISTRY_TABLE_ID, `CurrentValue.[${f.keyId}]="${key_id}"`);
  if (!rows.length) return [];
  await feishu.batchUpdate(env, env.REGISTRY_TABLE_ID, rows.map((r) => ({
    record_id: r.record_id,
    fields: { [f.status]: STATUS_REVOKED, [f.revokedAt]: ms(revoked_at) },
  })));
  return [`registry:revoked=${rows.length}`];
}

/// 提交成功后回写「最近提交」(best-effort)。
export async function recordSubmission(env, feishu, { key_id, at }) {
  if (!env.REGISTRY_TABLE_ID) return [];
  const f = REGISTRY.fields;
  const rows = await feishu.findRecords(env, env.REGISTRY_TABLE_ID, `CurrentValue.[${f.keyId}]="${key_id}"`);
  if (!rows.length) return [];
  await feishu.batchUpdate(env, env.REGISTRY_TABLE_ID, rows.map((r) => ({
    record_id: r.record_id,
    fields: { [f.lastSubmit]: ms(at) },
  })));
  return [`registry:lastSubmit=${rows.length}`];
}
