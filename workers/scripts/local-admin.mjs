// CLI 的本地管理实现:不经过公网接口,直接操作 KV / D1 / 飞书。
//
// 为什么单独抽一层:
//   ① `/admin/*` 已彻底从 Worker 移除,管理动作改由本机完成;
//   ② 但**规则只允许存在一处** —— 发 Key、撤销、"一人一把"、台账写入、日志留痕
//      全部直接复用 Worker 的同一批模块(../src/keys.js 等),不复制任何逻辑;
//   ③ 对 wrangler 的调用通过参数注入,便于用假实现做单元测试。
//
// 安全:写 KV 的值经 0600 临时文件传入,不出现在命令行参数里(否则会暴露在 ps 输出中)。

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { issueKey, listKeys, revokeKey, revokeExistingFor } from '../src/keys.js';
import { recordIssued, recordRevoked } from '../src/registry.js';
import { bootstrapTables } from '../src/tables.js';
import { logEvent, queryLogs } from '../src/logs.js';
import * as realFeishu from '../src/feishu.js';

/* ------------------------------------------------------------------ SQL */

export function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replace(/'/g, "''")}'`;
}

/// 把 `?` 占位符按顺序替换成字面量(wrangler d1 execute 不支持参数绑定)。
export function interpolate(sql, params = []) {
  let i = 0;
  return sql.replace(/\?/g, () => sqlLiteral(params[i++]));
}

/* --------------------------------------------------------------- KV 适配 */

/// 把 `wrangler kv key ... --remote` 包成 Workers KV binding 的形状。
export function kvAdapter(namespaceId, wrangler) {
  const ns = ['--namespace-id', namespaceId, '--remote'];
  const run = (args, what) => {
    const r = wrangler(args);
    if (r.code !== 0) throw new Error(`${what}失败:${(r.out ?? '').trim()}`);
    return r.out ?? '';
  };
  return {
    async get(key, type) {
      const r = wrangler(['kv', 'key', 'get', key, ...ns]);
      if (r.code !== 0) {
        if (/not found|does not exist|404/i.test(r.out ?? '')) return null;
        throw new Error(`读取 KV 失败:${(r.out ?? '').trim()}`);
      }
      const raw = (r.out ?? '').trim();
      if (!raw) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, value) {
      const dir = mkdtempSync(path.join(tmpdir(), 'dag-kv-'));
      const file = path.join(dir, 'value');
      try {
        writeFileSync(file, String(value), { mode: 0o600 });
        run(['kv', 'key', 'put', key, '--path', file, ...ns], `写入 KV ${key}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    async delete(key) {
      run(['kv', 'key', 'delete', key, ...ns], `删除 KV ${key}`);
    },
    async list({ prefix } = {}) {
      const args = ['kv', 'key', 'list', ...ns];
      if (prefix) args.push('--prefix', prefix);
      const out = run(args, '列出 KV');
      const start = out.indexOf('[');
      const parsed = start === -1 ? [] : JSON.parse(out.slice(start));
      return { keys: parsed.map((k) => ({ name: k.name })) };
    },
  };
}

/* --------------------------------------------------------------- D1 适配 */

/// 把 `wrangler d1 execute ... --remote --json` 包成 D1 binding 的形状。
export function d1Adapter(databaseName, wrangler) {
  const exec = (sql) => {
    const r = wrangler(['d1', 'execute', databaseName, '--remote', '--json', '--command', sql]);
    if (r.code !== 0) throw new Error(`D1 执行失败:${(r.out ?? '').trim()}`);
    const out = r.out ?? '';
    const start = out.indexOf('[');
    return start === -1 ? [] : JSON.parse(out.slice(start));
  };
  return {
    prepare(sql) {
      let params = [];
      const stmt = {
        bind(...values) { params = values; return stmt; },
        async run() { exec(interpolate(sql, params)); return { meta: { changes: 1 } }; },
        async all() { return { results: exec(interpolate(sql, params))[0]?.results ?? [] }; },
      };
      return stmt;
    },
  };
}

/* ------------------------------------------------------------ 管理动作 */

/// 签发一把 Key:解析身份 → 作废旧的(一人一把)→ 存 KV → 写台账 → 记审计。
export async function issueLocally(env, { member_id, member, email, open_id }, feishu = realFeishu) {
  const issued = await issueKey(env, feishu, { member_id, member, email, open_id });
  const superseded = [];
  for (const oldId of await revokeExistingFor(env, issued.open_id, issued.key_id)) {
    await recordRevoked(env, feishu, { key_id: oldId, revoked_at: new Date().toISOString() });
    superseded.push(oldId);
  }
  const registry = await recordIssued(env, feishu, {
    member: issued.member, member_id: issued.member_id, key_id: issued.key_id,
    open_id: issued.open_id, created_at: new Date().toISOString(),
  });
  await logEvent(env, {
    event: 'issue_key', outcome: 'ok', key_id: issued.key_id,
    member: issued.member, member_id: issued.member_id,
    detail: JSON.stringify({ registry, superseded, via: 'cli' }),
  });
  return { ...issued, superseded };
}

export async function revokeLocally(env, keyId, feishu = realFeishu) {
  const revoked = await revokeKey(env, keyId);
  const registry = await recordRevoked(env, feishu, { key_id: revoked.key_id, revoked_at: revoked.revoked_at });
  await logEvent(env, {
    event: 'revoke_key', outcome: 'ok', key_id: revoked.key_id,
    member: revoked.member, member_id: revoked.member_id,
    detail: JSON.stringify({ registry, via: 'cli' }),
  });
  return revoked;
}

export async function listKeysLocally(env) {
  return listKeys(env);
}

export async function bootstrapLocally(env, feishu = realFeishu) {
  const result = await bootstrapTables(env, feishu);
  await logEvent(env, {
    event: 'bootstrap', outcome: 'ok',
    detail: JSON.stringify({ table_id: result.tableId, registry: result.registryTableId, requests: result.requestTableId, via: 'cli' }),
  });
  return result;
}

export async function logsLocally(env, filters) {
  return queryLogs(env, filters);
}
