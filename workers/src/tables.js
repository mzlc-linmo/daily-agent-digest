// 飞书表的建表/建字段逻辑(只涉及主表「日报明细」)。
//
// 由本机 CLI 直连飞书 API 调用 —— Worker 上没有任何管理接口。
// 这个模块不依赖 Worker 专有 API(只用 fetch + env),Node 18+ 可直接运行。
//
// 设计变更(2026-09-14):「成员密钥」登记表与「密钥申请」表已删除,
// 成员自助填表申请 Key 的流程也一并取消。Key 只由管理员用本机 CLI 签发,
// 台账由 D1 的审计日志承担。

import { FIELDS, FIELD_DEFS } from './report.js';

/// 幂等地建好主表并补齐所有字段。返回 { tableId, created, existingFields }。
export async function bootstrapMainTable(env, feishu) {
  if (!env.BITABLE_APP_TOKEN) throw new Error('缺少 BITABLE_APP_TOKEN');
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

  const current = await feishu.listFields(env, tableId);
  const byName = new Map(current.map((field) => [field.field_name, field]));
  // 历史遗留:成员曾是文本字段,现在必须是人员字段(关联通讯录)。
  const legacyMember = byName.get(FIELDS.member);
  if (legacyMember && legacyMember.type !== 11) {
    const renamed = `${FIELDS.member}文本`;
    await feishu.updateField(env, legacyMember.field_id, { field_name: renamed, type: legacyMember.type }, tableId);
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
    await feishu.createField(env, definition, tableId);
    created.push(`field:${definition.field_name}`);
  }

  return { tableId, created, existingFields };
}
