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
    remark: '申请说明',
    status: '状态',        // 单选:待处理 / 已签发 / 已拒绝
    keyId: 'KeyID',
    handledAt: '处理时间',
  },
};

export const STATUS_ISSUED = '已启用';
export const STATUS_REVOKED = '已撤销';
export const REQUEST_PENDING = '待处理';
export const REQUEST_ISSUED = '已签发';

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

/// 签发后登记一行(并在申请表里把对应申请标为已签发)。
export async function recordIssued(env, feishu, { member, member_id, key_id, open_id, created_at }) {
  const notes = [];
  if (env.REGISTRY_TABLE_ID) {
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
  }
  // 把该成员最近的「待处理」申请标为已签发。
  // 注意:人员字段不能用 filter 匹配(实测 contains / 等值都命中 0),所以按状态取回后在本地比对。
  if (env.REQUEST_TABLE_ID && open_id) {
    const f = REQUESTS.fields;
    const pending = (await feishu.findRecords(env, env.REQUEST_TABLE_ID,
      `CurrentValue.[${f.status}]="${REQUEST_PENDING}"`))
      .filter((r) => (r.fields?.[f.applicant] ?? []).some((p) => p && p.id === open_id));
    if (pending.length) {
      await feishu.batchUpdate(env, env.REQUEST_TABLE_ID, pending.map((r) => ({
        record_id: r.record_id,
        fields: { [f.status]: REQUEST_ISSUED, [f.keyId]: key_id, [f.handledAt]: ms(new Date().toISOString()) },
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
