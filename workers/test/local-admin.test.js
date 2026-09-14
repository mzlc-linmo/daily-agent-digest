// CLI 本地管理层的测试。
//
// 管理接口已从 Worker 移除,建表/发 Key/撤销/查日志都改由本机执行 ——
// 这些测试保证"本机路径"和原来的服务端路径行为一致(用的是同一批模块)。

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bootstrapLocally, d1Adapter, interpolate, issueLocally, listKeysLocally,
  kvAdapter, parseJsonLoose, revokeLocally, sqlLiteral,
} from '../scripts/local-admin.mjs';
import { sha256Hex } from '../src/report.js';
import { FIELDS } from '../src/report.js';

/* ------------------------------------------------------------- 假实现 */

function fakeKV(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(key, type) {
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list({ prefix } = {}) {
      return { keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })) };
    },
  };
}

function fakeFeishu() {
  const tables = new Map();
  const seq = { n: 0 };
  return {
    tables,
    async listTables() { return [...tables].map(([table_id, t]) => ({ table_id, name: t.name })); },
    async createTable(_env, { name }) { const id = `tbl_${tables.size}`; tables.set(id, { name, rows: new Map() }); return id; },
    async listFields() { return [{ field_name: FIELDS.submitId, field_id: 'fld_root', type: 1 }]; },
    async createField() { return {}; },
    async updateField() { return {}; },
    async findRecords(_env, tableId, filter) {
      const table = tables.get(tableId);
      if (!table) return [];
      const mv = /CurrentValue\.\[([^\]]+)\]="([^"]*)"/.exec(filter ?? '');
      return [...table.rows].filter(([, f]) => !mv || String(f[mv[1]] ?? '') === mv[2])
        .map(([record_id, fields]) => ({ record_id, fields }));
    },
    async batchCreate(_env, tableId, rows) {
      const t = tables.get(tableId) ?? { rows: new Map() };
      tables.set(tableId, t);
      return rows.map((row) => { const id = `rec${seq.n++}`; t.rows.set(id, row.fields); return { record_id: id }; });
    },
    async batchUpdate(_env, tableId, records) {
      const table = tables.get(tableId);
      for (const r of records) table.rows.set(r.record_id, { ...(table.rows.get(r.record_id) ?? {}), ...r.fields });
      return records;
    },
    async batchDelete(_env, tableId, ids) {
      const table = tables.get(tableId);
      for (const id of ids) table.rows.delete(id);
    },
    async resolveOpenIds(_env, emails) { return Object.fromEntries(emails.map((e) => [e, `ou_${e.split('@')[0]}`])); },
  };
}

/* ---------------------------------------------------------- SQL 转义 */

test('sqlLiteral 正确转义,注入不成立', () => {
  assert.equal(sqlLiteral(null), 'NULL');
  assert.equal(sqlLiteral(42), '42');
  assert.equal(sqlLiteral(true), '1');
  assert.equal(sqlLiteral("O'Brien"), "'O''Brien'");
  assert.equal(sqlLiteral("'; DROP TABLE audit_log; --"), "'''; DROP TABLE audit_log; --'");
});

test('interpolate 按顺序替换占位符', () => {
  assert.equal(interpolate('SELECT * FROM t WHERE a = ? AND b = ?', ['x', 3]), "SELECT * FROM t WHERE a = 'x' AND b = 3");
});

test('parseJsonLoose 能在 JSON 后夹带噪声时正确解析', () => {
  // 这正是线上报的错:npx 把 npm notice 写到 stderr,和 stdout 拼在一起后解析失败
  const noisy = '[\n  {\n    "name": "key:aaaa"\n  }\n]\nnpm notice New major version of npm available!\n';
  assert.deepEqual(parseJsonLoose(noisy), [{ name: 'key:aaaa' }]);
  assert.deepEqual(parseJsonLoose('WARNING: proxy\n[{"results":[]}]\ntrailing'), [{ results: [] }]);
  assert.equal(parseJsonLoose('no json here'), null);
  // 字符串里的括号不能干扰配平
  assert.deepEqual(parseJsonLoose('[{"a":"}{"}]extra'), [{ a: '}{' }]);
});

/* ------------------------------------------------------------- 适配器 */

test('kvAdapter 把 wrangler kv 包成 KV binding 的形状', async () => {
  const calls = [];
  const fakeWrangler = (args) => {
    calls.push(args);
    const ok = (stdout) => ({ code: 0, stdout, stderr: '' });
    if (args[2] === 'get') return ok('{"member":"张三"}');
    if (args[2] === 'list') return ok('[\n  {\n    "name": "key:aaaa"\n  }\n]');
    return ok('');
  };
  const kv = kvAdapter('ns123', fakeWrangler);
  assert.deepEqual(await kv.get('key:aaaa', 'json'), { member: '张三' });
  assert.deepEqual((await kv.list({ prefix: 'key:' })).keys, [{ name: 'key:aaaa' }]);
  await kv.put('key:bbbb', '{"x":1}');
  await kv.delete('key:bbbb');
  // 值必须经 --path 传文件,不能出现在命令行参数里(否则会暴露在 ps 输出中)
  const put = calls.find((a) => a[2] === 'put');
  assert.ok(put.includes('--path'), '写 KV 必须用 --path');
  assert.ok(!put.some((a) => typeof a === 'string' && a.includes('"x"')), '值不得作为参数传入');
  assert.ok(put.includes('--remote'), '必须写远端');
});

test('kvAdapter 对不存在的键返回 null,其他错误抛出', async () => {
  const missing = kvAdapter('ns', () => ({ code: 1, stdout: '', stderr: 'Value not found' }));
  assert.equal(await missing.get('key:none', 'json'), null);
  const broken = kvAdapter('ns', () => ({ code: 1, stdout: '', stderr: 'boom' }));
  await assert.rejects(() => broken.get('key:x', 'json'), /读取 KV 失败/);
});

test('d1Adapter 执行 SQL 并返回结果', async () => {
  const seen = [];
  const fakeWrangler = (args) => {
    seen.push(args);
    return { code: 0, stdout: '[{"results":[{"n":1}],"success":true}]', stderr: '' };
  };
  const db = d1Adapter('logs-db', fakeWrangler);
  const rows = await db.prepare('SELECT ? AS n').bind(1).all();
  assert.deepEqual(rows.results, [{ n: 1 }]);
  assert.ok(seen[0].includes('--remote'));
  assert.ok(seen[0].some((a) => a.includes('SELECT 1 AS n')));
});

/* --------------------------------------------------------- 管理动作 */

test('issueLocally:签发 → 写台账 → 记审计,并且一人一把', async () => {
  const env = { KEYS: fakeKV() };
  const feishu = fakeFeishu();
  // 第一把
  const first = await issueLocally(env, { member_id: 'zhangsan', member: '张三', open_id: 'ou_zhangsan' }, feishu);
  assert.match(first.key, /^dag_[0-9a-f]{8}_/);
  assert.equal(first.superseded.length, 0);
  const stored = await env.KEYS.get(`key:${first.key_id}`, 'json');
  assert.equal(stored.open_id, 'ou_zhangsan');
  const secret = first.key.split('_').slice(2).join('_');
  assert.equal(stored.hash, await sha256Hex(secret), '只存 sha256');
  assert.equal(stored.key, undefined, 'KV 里绝不能存明文 Key');
  assert.equal(stored.secret_tail, secret.slice(-4), '只留末 4 位用于掩码');
  const listed = (await listKeysLocally(env))[0];
  assert.ok(listed.masked.startsWith(`dag_${first.key_id}_`), listed.masked);
  assert.ok(listed.masked.endsWith(secret.slice(-4)), listed.masked);
  assert.ok(!listed.masked.includes(secret), '掩码不得泄露完整密钥');
  assert.match(listed.masked, /\*{8}/, '中间应以星号代替');

  // 第二把:旧的必须作废
  const second = await issueLocally(env, { member_id: 'zhangsan', member: '张三', open_id: 'ou_zhangsan' }, feishu);
  assert.deepEqual(second.superseded, [first.key_id]);
  const old = await env.KEYS.get(`key:${first.key_id}`, 'json');
  assert.equal(old.enabled, false, '旧 Key 必须立即失效');

  // KV 里只剩新那把可用(一人一把)
  const enabled = [...env.KEYS.store.values()].map((v) => JSON.parse(v)).filter((r) => r.enabled !== false);
  assert.equal(enabled.length, 1);
  assert.equal(enabled[0].member_id, 'zhangsan');
});

test('issueLocally:邮箱解析不到人时拒绝签发', async () => {
  const env = { KEYS: fakeKV() };
  const feishu = fakeFeishu();
  feishu.resolveOpenIds = async () => ({ 'ghost@example.com': '' });
  await assert.rejects(
    () => issueLocally(env, { member_id: 'ghost', member: '查无此人', email: 'ghost@example.com' }, feishu),
    /contact:user.id:readonly/,
  );
  assert.equal(env.KEYS.store.size, 0, '失败不得留下半成品 Key');
});

test('listKeysLocally / revokeLocally', async () => {
  const env = { KEYS: fakeKV() };
  const feishu = fakeFeishu();
  const issued = await issueLocally(env, { member_id: 'lisi', member: '李四', open_id: 'ou_lisi' }, feishu);
  const keys = await listKeysLocally(env);
  assert.equal(keys.length, 1);
  assert.equal(keys[0].member, '李四');
  assert.equal(keys[0].linked, true);

  const revoked = await revokeLocally(env, issued.key_id, feishu);
  assert.equal(revoked.key_id, issued.key_id);
  const after = await listKeysLocally(env);
  assert.equal(after[0].enabled, false);
});

test('缺 D1 时写操作仍然成功,但会明确警告不会留痕', async () => {
  const env = { KEYS: fakeKV() }; // 故意不给 DB
  const feishu = fakeFeishu();
  const warnings = [];
  const original = console.warn;
  console.warn = (msg) => warnings.push(String(msg));
  try {
    const issued = await issueLocally(env, { member_id: 'liu', member: '刘', open_id: 'ou_liu' }, feishu);
    assert.ok(issued.key, '缺 D1 不应影响签发本身');
  } finally {
    console.warn = original;
  }
  assert.ok(warnings.some((w) => w.includes('不会记入审计日志')), JSON.stringify(warnings));
});

test('适配器支持异步 wrangler,且调用期间事件循环不被阻塞', async () => {
  // 这条测试针对"进度动画卡住"的根因:如果实现里用同步 spawn,
  // 定时器在调用期间根本无法触发(动画会画一帧就冻住)。
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 15);
  const asyncWrangler = async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return { code: 0, stdout: '[{"name":"key:aaaa"}]', stderr: '' };
  };
  const kv = kvAdapter('ns', asyncWrangler);
  const listed = await kv.list({ prefix: 'key:' });
  clearInterval(timer);
  assert.deepEqual(listed.keys, [{ name: 'key:aaaa' }]);
  assert.ok(ticks >= 3, `调用期间定时器应持续触发,实际 ${ticks} 次`);
});

test('bootstrapLocally 只建主表且幂等', async () => {
  const env = { BITABLE_APP_TOKEN: 'bascn_test', BITABLE_TABLE_ID: 'tbl_main' };
  const feishu = fakeFeishu();
  const first = await bootstrapLocally(env, feishu);
  assert.equal(first.tableId, 'tbl_main');
  assert.equal(first.registryTableId, undefined, '登记表已取消');
  const second = await bootstrapLocally(env, feishu);
  assert.equal(second.tableId, first.tableId, '重复执行应复用同一张表');
});
