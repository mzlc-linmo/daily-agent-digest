// 无依赖单元测试:node --test workers/test
//
// 用假的飞书客户端覆盖 created / updated / unchanged / 鉴权 / 校验 / 失败语义,
// 不需要 Worker 运行时,也不需要网络。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/handler.js';
import { logEvent } from '../src/logs.js';
import { sha256Hex, FIELDS, FIELD_DEFS } from '../src/report.js';

const SECRET = 'test-secret-value';
let ENV;

/// 假 KV:只实现本服务用到的 get/put/list。
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

async function makeEnv() {
  const hash = await sha256Hex(SECRET);
  return {
    KEYS: fakeKV({
      'key:k1': JSON.stringify({ hash, member: '张三', member_id: 'zhangsan', open_id: 'ou_zhangsan', enabled: true }),
      'key:k2': JSON.stringify({ hash, member: '李四', member_id: 'lisi', open_id: 'ou_lisi', enabled: false }),
    }),
    ADMIN_TOKEN: 'admin-token',
    FEISHU_APP_ID: 'cli_test',
    FEISHU_APP_SECRET: 'secret',
    BITABLE_APP_TOKEN: 'bascn_test',
    BITABLE_TABLE_ID: 'tbl_test',
  };
}

const KEY = `dag_k1_${SECRET}`;

/// 假飞书客户端:内存里的多表实现,足以覆盖主表 + 两张管理表。
function fakeFeishu() {
  const tables = new Map(); // tableId -> { name, fields:Set, rows:Map(record_id -> fields) }
  const calls = { create: 0, update: 0, delete: 0, find: 0, resolve: 0 };
  let seq = 0;
  const newId = () => `rec${seq++}`;
  const ensure = (id) => {
    if (!tables.has(id)) tables.set(id, { name: id, fields: new Set(), rows: new Map() });
    return tables.get(id);
  };
  // 支持 CurrentValue.[字段]="值" 与 CurrentValue.[字段].contains("值")
  const matches = (fields, filter) => {
    if (!filter) return true;
    const equals = [...filter.matchAll(/CurrentValue\.\[([^\]]+)\]="([^"]*)"/g)];
    const contains = [...filter.matchAll(/CurrentValue\.\[([^\]]+)\]\.contains\("([^"]*)"\)/g)];
    return equals.every(([, k, v]) => String(fields[k] ?? '') === v)
      && contains.every(([, k, v]) => (fields[k] ?? []).some?.((p) => p.id === v) ?? false);
  };
  return {
    tables, calls,
    async listTables() { return [...tables].map(([table_id, t]) => ({ table_id, name: t.name })); },
    async createTable(_env, { name, fields = [] }) {
      const id = `tbl_${name}`;
      const t = ensure(id); t.name = name;
      for (const f of fields) t.fields.add(f.field_name);
      return id;
    },
    async listFields(_env, tableId) { return [...ensure(tableId).fields].map((field_name) => ({ field_name })); },
    async createField(_env, field, tableId) { ensure(tableId).fields.add(field.field_name); return {}; },
    async updateField(_env, fieldId, body, tableId) {
      const t = ensure(tableId); t.fields.delete(fieldId); t.fields.add(body.field_name); return {};
    },
    async findRecords(_env, tableId, filter) {
      calls.find += 1;
      return [...ensure(tableId).rows].filter(([, f]) => matches(f, filter))
        .map(([record_id, fields]) => ({ record_id, fields }));
    },
    async findRecordsBySubmitId(env, submitId) { return this.findRecords(env, env.BITABLE_TABLE_ID, `CurrentValue.[提交ID]="${submitId}"`); },
    async batchCreate(_env, tableId, rows) {
      calls.create += 1;
      const t = ensure(tableId);
      return rows.map((row) => { const record_id = newId(); t.rows.set(record_id, row.fields); return { record_id, fields: row.fields }; });
    },
    async batchUpdate(_env, tableId, records) {
      calls.update += 1;
      const t = ensure(tableId);
      for (const r of records) t.rows.set(r.record_id, { ...(t.rows.get(r.record_id) ?? {}), ...r.fields });
      return records;
    },
    async batchDelete(_env, tableId, ids) {
      calls.delete += 1;
      const t = ensure(tableId);
      for (const id of ids) t.rows.delete(id);
    },
    async resolveOpenIds(_env, emails = []) {
      calls.resolve += 1;
      const out = {};
      for (const email of emails) out[email] = email === 'unlinked@example.com' ? '' : `ou_${email.split('@')[0]}`;
      return out;
    },
    async healthcheck() { return true; },
  };
}

/// 假 D1:记录 INSERT,可按需让 run() 抛错(验证"日志失败不影响业务")。
function fakeDB({ failOnInsert = false } = {}) {
  const inserted = [];
  return {
    inserted,
    prepare(sql) {
      const stmt = {
        params: [],
        bind(...params) { stmt.params = params; return stmt; },
        async run() {
          if (/INSERT/i.test(sql)) {
            if (failOnInsert) throw new Error('D1 不可用');
            inserted.push(Object.fromEntries(sql.match(/\((.*?)\)/s)[1].split(',').map((c) => c.trim()).map((c, i) => [c, stmt.params[i]])));
          }
          return { meta: { changes: 1 } };
        },
        async all() { return { results: inserted }; },
      };
      return stmt;
    },
  };
}

function post(path, body, { key = KEY, headers = {} } = {}) {
  return new Request(`https://digest.example.com${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': 'test-agent', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const REPORT = {
  date: '2026-09-13',
  release_version: 'v0.5.1',
  report_chars: 120,
  work_items: [
    { title: '采集器重构', desc: '统一窗口过滤', status: 'completed', source_task_ids: ['codex/abc'] },
    { title: 'CI 修复', desc: '签名顺序', status: 'in_progress', source_task_ids: ['deepseek-harness/x'] },
  ],
};

test.before(async () => { ENV = await makeEnv(); });

test('首次提交创建行,一行一个工作项', async () => {
  const feishu = fakeFeishu();
  const res = await handleRequest(post('/api/v1/digests', REPORT), ENV, { feishu, now: () => 1700000000000 });
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.equal(body.mode, 'created');
  assert.equal(body.records.length, 2);
  assert.equal(feishu.tables.get('tbl_test').rows.size, 2);
  const fields = [...feishu.tables.get('tbl_test').rows.values()][0];
  assert.equal(fields[FIELDS.submitId], 'zhangsan-2026-09-13');
  assert.deepEqual(fields[FIELDS.member], [{ id: 'ou_zhangsan' }], '成员用签发时绑定的 open_id');
  assert.equal(fields[FIELDS.memberId], 'zhangsan');
  assert.equal(fields[FIELDS.sources][0], 'codex');
  assert.equal(body.member_linked, true);
});

test('成员身份由 Key 决定,请求体里的名字不被采信', async () => {
  const feishu = fakeFeishu();
  await handleRequest(post('/api/v1/digests', { ...REPORT, member: '李四', member_id: 'lisi' }), ENV, { feishu });
  assert.equal([...feishu.tables.get('tbl_test').rows.values()][0][FIELDS.memberId], 'zhangsan');
  assert.deepEqual([...feishu.tables.get('tbl_test').rows.values()][0][FIELDS.member], [{ id: 'ou_zhangsan' }]);
});

test('同一天内容不变时幂等返回,不写表', async () => {
  const feishu = fakeFeishu();
  await handleRequest(post('/api/v1/digests', REPORT), ENV, { feishu });
  const before = { ...feishu.calls };
  const res = await handleRequest(post('/api/v1/digests', REPORT), ENV, { feishu });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.mode, 'unchanged');
  assert.equal(feishu.calls.create, before.create);
  assert.equal(feishu.calls.update, before.update);
  assert.equal(feishu.tables.get('tbl_test').rows.size, 2);
});

test('同一天内容变化时覆盖,行数不变', async () => {
  const feishu = fakeFeishu();
  await handleRequest(post('/api/v1/digests', REPORT), ENV, { feishu });
  const changed = { ...REPORT, work_items: [{ ...REPORT.work_items[0], desc: '改了内容' }] };
  const res = await handleRequest(post('/api/v1/digests', changed), ENV, { feishu });
  const body = await res.json();
  assert.equal(body.mode, 'updated');
  assert.equal(feishu.tables.get('tbl_test').rows.size, 1, '工作项变少时多余的行应被删除');
  assert.equal([...feishu.tables.get('tbl_test').rows.values()][0][FIELDS.desc], '改了内容');
});





test('拒绝无效 Key、停用成员与格式错误的 Key', async () => {
  const feishu = fakeFeishu();
  const bad = await handleRequest(post('/api/v1/digests', REPORT, { key: 'dag_k1_wrong' }), ENV, { feishu });
  assert.equal(bad.status, 401);
  assert.equal((await bad.json()).error.code, 'invalid_key');

  const revoked = await handleRequest(post('/api/v1/digests', REPORT, { key: `dag_k2_${SECRET}` }), ENV, { feishu });
  assert.equal(revoked.status, 403);
  assert.equal((await revoked.json()).error.code, 'key_revoked');

  const malformed = await handleRequest(post('/api/v1/digests', REPORT, { key: 'nonsense' }), ENV, { feishu });
  assert.equal(malformed.status, 401);
});

test('校验失败返回 422 且不写表', async () => {
  const feishu = fakeFeishu();
  for (const payload of [
    { ...REPORT, date: '2026/09/13' },
    { ...REPORT, work_items: [] },
    { ...REPORT, work_items: [{ title: '', desc: 'x' }] },
    { ...REPORT, work_items: [{ title: 'a', status: 'unknown' }] },
  ]) {
    const res = await handleRequest(post('/api/v1/digests', payload), ENV, { feishu });
    assert.equal(res.status, 422, JSON.stringify(payload));
  }
  assert.equal(feishu.calls.create, 0);
  assert.equal(feishu.tables.get('tbl_test')?.rows.size ?? 0, 0);
});

test('请求体不是 JSON 时返回 400', async () => {
  const feishu = fakeFeishu();
  const res = await handleRequest(post('/api/v1/digests', '{oops', {}), ENV, { feishu });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'invalid_json');
});

test('写表失败时返回 502,绝不返回成功', async () => {
  const feishu = fakeFeishu();
  feishu.batchCreate = async () => {
    const err = new Error('飞书接口失败');
    err.status = 502;
    err.code = 'bitable_unavailable';
    err.logId = 'log-123';
    throw err;
  };
  const res = await handleRequest(post('/api/v1/digests', REPORT), ENV, { feishu });
  const body = await res.json();
  assert.equal(res.status, 502);
  assert.equal(body.error.code, 'bitable_unavailable');
  assert.equal(body.error.log_id, 'log-123');
});

test('/api/v1/me 返回 Key 对应的成员', async () => {
  const res = await handleRequest(new Request('https://digest.example.com/api/v1/me', {
    headers: { Authorization: `Bearer ${KEY}` },
  }), ENV, { feishu: fakeFeishu() });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.member, '张三');
  assert.equal(body.member_id, 'zhangsan');
});

test('/api/v1/digests?date= 反映是否已提交', async () => {
  const feishu = fakeFeishu();
  await handleRequest(post('/api/v1/digests', REPORT), ENV, { feishu });
  const res = await handleRequest(new Request('https://digest.example.com/api/v1/digests?date=2026-09-13', {
    headers: { Authorization: `Bearer ${KEY}` },
  }), ENV, { feishu });
  const body = await res.json();
  assert.equal(body.submitted, true);
  assert.equal(body.count, 2);
});












test('主表字段定义必须覆盖运行时用到的每一个字段', () => {
  // 防"补丁静默没生效":定义漏了字段,重新 bootstrap 出来的表就会缺列
  const names = new Set(FIELD_DEFS.map((d) => d.field_name));
  for (const name of Object.values(FIELDS)) {
    assert.ok(names.has(name), `主表定义缺少字段「${name}」`);
  }
  // 成员必须是人员字段(关联通讯录)
  const member = FIELD_DEFS.find((d) => d.field_name === FIELDS.member);
  assert.equal(member.type, 11);
});

test('成功提交写入审计日志', async () => {
  const feishu = fakeFeishu();
  const env = { ...ENV, DB: fakeDB() };
  const res = await handleRequest(post('/api/v1/digests', REPORT), env, { feishu });
  assert.equal(res.status, 201);
  const row = env.DB.inserted.find((r) => r.event === 'submit');
  assert.ok(row, '应写入 submit 事件');
  assert.equal(row.outcome, 'ok');
  assert.equal(row.member_id, 'zhangsan');
  assert.equal(row.date, REPORT.date);
  assert.equal(row.items, REPORT.work_items.length);
  assert.equal(row.mode, 'created');
  assert.equal(row.user_agent, 'test-agent');
});

test('失败的提交同样入日志(鉴权失败/校验失败)', async () => {
  const feishu = fakeFeishu();
  const env = { ...ENV, DB: fakeDB() };
  await handleRequest(post('/api/v1/digests', REPORT, { key: 'dag_bad_wrong' }), env, { feishu });
  await handleRequest(post('/api/v1/digests', { ...REPORT, work_items: [] }), env, { feishu });
  const errors = env.DB.inserted.filter((r) => r.event === 'submit' && r.outcome === 'error');
  assert.equal(errors.length, 2, '两次失败都要留痕');
  assert.deepEqual(errors.map((r) => r.error_code).sort(), ['invalid_key', 'validation_failed']);
});

test('日志写失败不影响日报提交', async () => {
  const feishu = fakeFeishu();
  const env = { ...ENV, DB: fakeDB({ failOnInsert: true }) };
  const res = await handleRequest(post('/api/v1/digests', REPORT), env, { feishu });
  assert.equal(res.status, 201, 'D1 出问题不能拖垮提交');
});

test('没绑定 D1 时日志静默跳过', async () => {
  const env = { ...ENV };
  delete env.DB;
  assert.equal(await logEvent(env, { event: 'submit', outcome: 'ok' }), false);
  const feishu = fakeFeishu();
  const res = await handleRequest(post('/api/v1/digests', REPORT), env, { feishu });
  assert.equal(res.status, 201);
});



test('管理接口已彻底移除,公网不存在任何管理入口', async () => {
  const feishu = fakeFeishu();
  for (const path of ['/admin/keys', '/admin/keys/revoke', '/admin/bootstrap', '/admin/logs']) {
    const get = await handleRequest(new Request(`https://digest.example.com${path}`), ENV, { feishu });
    assert.equal(get.status, 404, `${path} 不应存在`);
    const posted = await handleRequest(post(path, {}), ENV, { feishu });
    assert.equal(posted.status, 404, `${path} 不应存在(POST)`);
  }
});

test('审计日志记录字数与版本(字段名必须与校验层一致)', async () => {
  const feishu = fakeFeishu();
  const env = { ...ENV, DB: fakeDB() };
  await handleRequest(post('/api/v1/digests', { ...REPORT, report_chars: 271, release_version: 'v9.9.9' }), env, { feishu });
  const row = env.DB.inserted.find((r) => r.event === 'submit');
  assert.equal(row.report_chars, 271, 'report_chars 不得为 null(曾因 camelCase/snake_case 不匹配恒为 null)');
  assert.equal(row.release_version, 'v9.9.9');
});

test('未预期异常不回显内部信息', async () => {
  const feishu = fakeFeishu();
  feishu.batchCreate = async () => { throw new Error('内部细节:table=tbl_secret code=1254302'); };
  const res = await handleRequest(post('/api/v1/digests', REPORT), ENV, { feishu });
  const body = await res.json();
  assert.equal(res.status, 500);
  assert.equal(body.error.code, 'internal_error');
  assert.ok(!JSON.stringify(body).includes('tbl_secret'), `不得泄露内部信息:${JSON.stringify(body)}`);
});

test('校验类错误仍然回显可读原因', async () => {
  const feishu = fakeFeishu();
  const res = await handleRequest(post('/api/v1/digests', { ...REPORT, date: '2026/09/13' }), ENV, { feishu });
  assert.equal(res.status, 422);
  assert.match((await res.json()).error.message, /date/);
});

test('元信息字段超长会被截断,不会撑大表格与日志', async () => {
  const feishu = fakeFeishu();
  const env = { ...ENV, DB: fakeDB() };
  await handleRequest(post('/api/v1/digests', {
    ...REPORT,
    release_version: 'v'.repeat(500),
    work_items: [{ title: 't', desc: 'd', status: 'completed',
                   source_task_ids: Array.from({ length: 100 }, (_, i) => `source${i}`.repeat(20)) }],
  }), env, { feishu });
  const row = [...feishu.tables.get(ENV.BITABLE_TABLE_ID).rows.values()][0];
  assert.ok(String(row[FIELDS.appVersion]).length <= 64, '版本号应被截断');
  assert.ok(row[FIELDS.sources].length <= 20, `来源条数应被限制,实际 ${row[FIELDS.sources].length}`);
  assert.ok(row[FIELDS.sources].every((x) => x.length <= 100), '单条来源应被截断');
});

test('未知路径返回 404', async () => {
  const res = await handleRequest(new Request('https://digest.example.com/nope'), ENV, { feishu: fakeFeishu() });
  assert.equal(res.status, 404);
});
