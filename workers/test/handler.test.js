// 无依赖单元测试:node --test workers/test
//
// 用假的飞书客户端覆盖 created / updated / unchanged / 鉴权 / 校验 / 失败语义,
// 不需要 Worker 运行时,也不需要网络。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/handler.js';
import { sha256Hex } from '../src/report.js';
import { FIELDS } from '../src/report.js';

const SECRET = 'test-secret-value';
let ENV;

async function makeEnv() {
  const hash = await sha256Hex(SECRET);
  return {
    API_KEYS: JSON.stringify({
      k1: { hash, member: '张三', member_id: 'zhangsan', enabled: true, email: 'zhangsan@example.com' },
      k2: { hash, member: '李四', member_id: 'lisi', enabled: false },
    }),
    ADMIN_TOKEN: 'admin-token',
    FEISHU_APP_ID: 'cli_test',
    FEISHU_APP_SECRET: 'secret',
    BITABLE_APP_TOKEN: 'bascn_test',
    BITABLE_TABLE_ID: 'tbl_test',
  };
}

const KEY = `dag_k1_${SECRET}`;

/// 假飞书客户端:只在内存里维护行,并记录调用次数以便断言"幂等时不写表"。
function fakeFeishu() {
  const rows = new Map(); // record_id -> fields
  const calls = { create: 0, update: 0, delete: 0, find: 0 };
  let nextId = 0;
  return {
    rows, calls,
    async findRecordsBySubmitId(_env, submitId) {
      calls.find += 1;
      return [...rows.entries()]
        .filter(([, fields]) => fields[FIELDS.submitId] === submitId)
        .map(([record_id, fields]) => ({ record_id, fields }));
    },
    async batchCreate(_env, newRows) {
      calls.create += 1;
      return newRows.map((row) => {
        const record_id = `rec${nextId++}`;
        rows.set(record_id, row.fields);
        return { record_id, fields: row.fields };
      });
    },
    async batchUpdate(_env, updates) {
      calls.update += 1;
      for (const row of updates) rows.set(row.record_id, row.fields);
      return updates.map((row) => ({ record_id: row.record_id, fields: row.fields }));
    },
    async batchDelete(_env, ids) {
      calls.delete += 1;
      for (const id of ids) rows.delete(id);
    },
    async resolveOpenIds(_env, emails = []) {
      calls.resolve = (calls.resolve ?? 0) + 1;
      const out = {};
      for (const email of emails) out[email] = email === 'unlinked@example.com' ? '' : `ou_${email.split('@')[0]}`;
      return out;
    },
    async updateField() { return {}; },
    async healthcheck() { return true; },
    async listTables() { return [{ table_id: 'tbl_test', name: '日报明细' }]; },
    async listFields() { return Object.values(FIELDS).map((field_name) => ({ field_name })); },
    async createField() { return {}; },
    async createTable() { return 'tbl_new'; },
  };
}

function post(path, body, { key = KEY, headers = {} } = {}) {
  return new Request(`https://digest.example.com${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...headers },
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
  assert.equal(feishu.rows.size, 2);
  const fields = [...feishu.rows.values()][0];
  assert.equal(fields[FIELDS.submitId], 'zhangsan-2026-09-13');
  assert.deepEqual(fields[FIELDS.member], [{ id: 'ou_zhangsan' }], '成员是人员字段,写入 open_id');
  assert.equal(fields[FIELDS.memberId], 'zhangsan');
  assert.equal(fields[FIELDS.sources][0], 'codex');
  assert.equal(body.member_linked, true);
});

test('成员身份由 Key 决定,请求体里的名字不被采信', async () => {
  const feishu = fakeFeishu();
  await handleRequest(post('/api/v1/digests', { ...REPORT, member: '李四', member_id: 'lisi' }), ENV, { feishu });
  assert.equal([...feishu.rows.values()][0][FIELDS.memberId], 'zhangsan');
  assert.deepEqual([...feishu.rows.values()][0][FIELDS.member], [{ id: 'ou_zhangsan' }]);
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
  assert.equal(feishu.rows.size, 2);
});

test('同一天内容变化时覆盖,行数不变', async () => {
  const feishu = fakeFeishu();
  await handleRequest(post('/api/v1/digests', REPORT), ENV, { feishu });
  const changed = { ...REPORT, work_items: [{ ...REPORT.work_items[0], desc: '改了内容' }] };
  const res = await handleRequest(post('/api/v1/digests', changed), ENV, { feishu });
  const body = await res.json();
  assert.equal(body.mode, 'updated');
  assert.equal(feishu.rows.size, 1, '工作项变少时多余的行应被删除');
  assert.equal([...feishu.rows.values()][0][FIELDS.desc], '改了内容');
});

test('解析不到 open_id 时成员列留空,但提交仍然成功', async () => {
  const feishu = fakeFeishu();
  const env = {
    ...ENV,
    API_KEYS: JSON.stringify({ k9: { hash: await sha256Hex(SECRET), member: '王五', member_id: 'wangwu',
                                     email: 'unlinked@example.com', enabled: true } }),
  };
  const res = await handleRequest(post('/api/v1/digests', REPORT, { key: `dag_k9_${SECRET}` }), env, { feishu });
  const body = await res.json();
  assert.equal(res.status, 201, '解析不到人不应该让提交失败');
  assert.equal(body.member_linked, false);
  assert.equal([...feishu.rows.values()][0][FIELDS.member], undefined, '宁可不写,也不写错类型');
});

test('通讯录接口报错时不影响提交', async () => {
  const feishu = fakeFeishu();
  feishu.resolveOpenIds = async () => { throw new Error('缺少通讯录权限'); };
  const res = await handleRequest(post('/api/v1/digests', REPORT), ENV, { feishu });
  const body = await res.json();
  assert.equal(res.status, 201);
  assert.equal(body.member_linked, false);
});

test('拒绝无效 Key、停用成员与格式错误的 Key', async () => {
  const feishu = fakeFeishu();
  const bad = await handleRequest(post('/api/v1/digests', REPORT, { key: 'dag_k1_wrong' }), ENV, { feishu });
  assert.equal(bad.status, 401);
  assert.equal((await bad.json()).error.code, 'invalid_key');

  const disabled = await handleRequest(post('/api/v1/digests', REPORT, { key: `dag_k2_${SECRET}` }), ENV, { feishu });
  assert.equal(disabled.status, 403);
  assert.equal((await disabled.json()).error.code, 'member_disabled');

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
  assert.equal(feishu.rows.size, 0);
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

test('bootstrap 需要管理口令,并返回 table_id', async () => {
  const feishu = fakeFeishu();
  const env = { ...ENV, BITABLE_TABLE_ID: '' };
  const denied = await handleRequest(post('/admin/bootstrap', {}, { key: 'wrong', headers: {} }), env, { feishu });
  assert.equal(denied.status, 401);

  const ok = await handleRequest(new Request('https://digest.example.com/admin/bootstrap', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ENV.ADMIN_TOKEN}` },
  }), env, { feishu });
  const body = await ok.json();
  assert.equal(ok.status, 200);
  assert.ok(body.table_id, 'bootstrap 必须返回 table_id');
});

test('未知路径返回 404', async () => {
  const res = await handleRequest(new Request('https://digest.example.com/nope'), ENV, { feishu: fakeFeishu() });
  assert.equal(res.status, 404);
});
