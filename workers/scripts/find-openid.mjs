#!/usr/bin/env node
// 从企业已有表格里查某人的飞书 open_id(签发 Key 需要它)。
//
//   node workers/scripts/find-openid.mjs            # 列出所有能找到的人
//   node workers/scripts/find-openid.mjs 张三        # 按姓名(模糊)查
//
// 依赖:本机钥匙串里有飞书应用凭据(service zentao.mzlc.me,account feishu-app-id / feishu-app-secret)。
// 原理:遍历应用能看到的全部多维表格,读取其中所有「人员」字段的取值。

import { execFileSync } from 'node:child_process';

const BASE = 'https://open.feishu.cn/open-apis';

function keychain(service, account) {
  try {
    return execFileSync('security', ['find-generic-password', '-s', service, '-a', account, '-w'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

async function api(path, token, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8', ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (body.code !== 0) throw new Error(`${path} → code=${body.code} ${body.msg}`);
  return body.data ?? {};
}

async function main() {
  const query = (process.argv[2] ?? '').trim();
  const appId = keychain('zentao.mzlc.me', 'feishu-app-id');
  const appSecret = keychain('zentao.mzlc.me', 'feishu-app-secret');
  if (!appId || !appSecret) {
    console.error('未在钥匙串找到飞书凭据(service=zentao.mzlc.me,account=feishu-app-id / feishu-app-secret)');
    process.exit(2);
  }

  const tokenRes = await fetch(`${BASE}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const tokenBody = await tokenRes.json();
  if (tokenBody.code !== 0) throw new Error(`取 token 失败:${tokenBody.msg}`);
  const token = tokenBody.tenant_access_token;

  // 应用自有空间里的多维表格
  const files = await api('/drive/v1/files?page_size=200', token);
  const bases = (files.files ?? []).filter((f) => f.type === 'bitable').map((f) => ({ token: f.token, name: f.name }));
  // 别人共享给应用、但不在自有空间里的表格:用 DIGEST_SCAN_BASES 补充(base_token[:名称],逗号分隔)
  for (const entry of (process.env.DIGEST_SCAN_BASES ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [token_, name] = entry.split(':');
    if (!bases.some((b) => b.token === token_)) bases.push({ token: token_, name: name || token_ });
  }
  const people = new Map();

  for (const base of bases) {
    const tables = (await api(`/bitable/v1/apps/${base.token}/tables?page_size=100`, token).catch(() => ({}))).items ?? [];
    for (const table of tables) {
      const fields = (await api(`/bitable/v1/apps/${base.token}/tables/${table.table_id}/fields?page_size=100`, token).catch(() => ({}))).items ?? [];
      const personFields = fields.filter((f) => f.type === 11).map((f) => f.field_name);
      if (!personFields.length) continue;
      const records = (await api(`/bitable/v1/apps/${base.token}/tables/${table.table_id}/records?page_size=200`, token).catch(() => ({}))).items ?? [];
      for (const record of records) {
        for (const field of personFields) {
          for (const person of record.fields?.[field] ?? []) {
            if (person?.id) people.set(person.id, { name: person.name ?? '(无名)', table: `${base.name}/${table.name}` });
          }
        }
      }
    }
  }

  const rows = [...people].filter(([, v]) => !query || v.name.includes(query));
  if (!rows.length) {
    console.log(query ? `没有找到姓名包含「${query}」的人` : '没有找到任何人员字段');
    console.log('提示:① 该成员可能只在别人共享的表格里出现,用 DIGEST_SCAN_BASES 补充 base_token;');
    console.log('      ② 若从未出现在任何人员字段里,需要应用开通 contact:user.id:readonly 后用邮箱解析');
    process.exit(1);
  }
  console.log(`共 ${rows.length} 人${query ? `(匹配「${query}」)` : ''}:`);
  for (const [id, v] of rows) console.log(`  ${v.name.padEnd(12)} ${id}   来源:${v.table}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
