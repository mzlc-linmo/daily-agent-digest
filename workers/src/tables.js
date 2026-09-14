// 飞书表的建表/建字段逻辑。
//
// 抽成独立模块的原因:`/admin/*` 已从 Worker 上彻底移除,现在由**本机 CLI**
// 直连飞书 API 建表。CLI 直接 import 这里的函数,和 Worker 用**同一份**定义 ——
// 规则只存在一处,不会出现"两边漂移"。
//
// 这个模块不依赖任何 Worker 专有 API(只用 fetch + env),Node 18+ 可直接运行。

import { FIELDS, FIELD_DEFS } from './report.js';
import { ensureTable, registryFieldDefs, requestFieldDefs, REGISTRY, REQUESTS } from './registry.js';

/// 幂等地把主表 + 两张管理表建好,并补齐所有字段。
/// 返回 { tableId, registryTableId, requestTableId, created, existingFields }。
export async function bootstrapTables(env, feishu) {
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

  // 两张管理表(与主表同一个 base)
  const adminTables = {};
  for (const [key, spec, defs] of [['registry', REGISTRY, registryFieldDefs()], ['requests', REQUESTS, requestFieldDefs()]]) {
    const result = await ensureTable(env, feishu, spec, defs);
    if (!result.tableId) throw new Error(`建表 ${spec.name} 失败:未拿到表 id`);
    adminTables[key] = result.tableId;
    created.push(...result.created);
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

  return {
    tableId,
    registryTableId: adminTables.registry,
    requestTableId: adminTables.requests,
    created,
    existingFields,
  };
}
