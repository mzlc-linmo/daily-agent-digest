// 配置被清理 / 换机器后,靠这两个解析把已有部署的 id 找回来,不必手抄 32 位 id。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  activeVersionId, bindingsFromVersion, d1DatabaseNames, kvNamespaceTitles, parseBitableInput,
  pickD1DatabaseId, pickKvNamespaceId,
} from '../scripts/recover.mjs';

const KV_ID = '0123456789abcdef0123456789abcdef';
const D1_ID = 'fedcba98-7654-3210-fedc-ba9876543210';

// wrangler kv namespace list 的输出就是 JSON.stringify(数组)(已核对 wrangler 源码)
const KV_OUTPUT = `[
  {
    "id": "${KV_ID}",
    "title": "KEYS",
    "supports_url_encoding": true
  },
  {
    "id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "title": "别的命名空间",
    "supports_url_encoding": false
  }
]`;

const D1_OUTPUT = `[
  {"uuid": "${D1_ID}", "name": "daily-agent-digest-logs", "created_at": "2026-01-01T00:00:00Z"},
  {"uuid": "11111111-2222-3333-4444-555555555555", "name": "unrelated"}
]`;

test('finds the KEYS namespace id by title', () => {
  assert.equal(pickKvNamespaceId(KV_OUTPUT), KV_ID);
});

test('finds the D1 database id by name', () => {
  assert.equal(pickD1DatabaseId(D1_OUTPUT), D1_ID);
});

test('other namespaces/databases are ignored', () => {
  assert.equal(pickKvNamespaceId(KV_OUTPUT, '不存在的名字'), '');
  assert.equal(pickD1DatabaseId(D1_OUTPUT, '不存在的库'), '');
});

test('malformed or empty output yields nothing instead of throwing', () => {
  for (const bad of ['', 'null', '{}', 'not json', '[]', undefined]) {
    assert.equal(pickKvNamespaceId(bad), '');
    assert.equal(pickD1DatabaseId(bad), '');
  }
});

test('stray log lines around the JSON are tolerated', () => {
  // npx 偶尔会在 stdout 里混进提示行;截取首个 [ 到末个 ] 后仍应解析成功。
  assert.equal(pickKvNamespaceId(`npm notice something\n${KV_OUTPUT}\n`), KV_ID);
});

test('an id of the wrong shape is rejected rather than trusted', () => {
  const wrong = '[{"id": "REPLACE_WITH_YOUR_KV_NAMESPACE_ID", "title": "KEYS"}]';
  assert.equal(pickKvNamespaceId(wrong), '', '占位符不是合法 id');
  const wrongD1 = '[{"uuid": "not-a-uuid", "name": "daily-agent-digest-logs"}]';
  assert.equal(pickD1DatabaseId(wrongD1), '');
});

// ---- 一条链接顶两个问题:app_token 与 table_id -------------------------------

test('parses app_token and table_id out of a bitable URL', () => {
  const p = parseBitableInput('https://acme.feishu.cn/base/JHoFbrmTBaTN8nsmoYScZyTpnEb?table=tblAbCdEf123&view=vewX');
  assert.equal(p.kind, 'base');
  assert.equal(p.appToken, 'JHoFbrmTBaTN8nsmoYScZyTpnEb');
  assert.equal(p.tableId, 'tblAbCdEf123');
});

test('accepts the older bascn token, Lark hosts and a missing scheme', () => {
  for (const url of [
    'https://acme.feishu.cn/base/bascnAbCdEf123456?table=tblXyZ',
    'https://acme.larksuite.com/base/bascnAbCdEf123456?table=tblXyZ',
    'acme.feishu.cn/base/bascnAbCdEf123456?table=tblXyZ',
    '  https://acme.feishu.cn/base/bascnAbCdEf123456?table=tblXyZ&view=v1  ',
  ]) {
    const p = parseBitableInput(url);
    assert.equal(p.appToken, 'bascnAbCdEf123456', url);
    assert.equal(p.tableId, 'tblXyZ', url);
  }
});

test('a wiki link yields the node token, which is not the app token', () => {
  const p = parseBitableInput('https://acme.feishu.cn/wiki/NodeToken123456?table=tblWiki1');
  assert.equal(p.kind, 'wiki');
  assert.equal(p.nodeToken, 'NodeToken123456');
  assert.equal(p.appToken, '', 'wiki 链接里没有 app_token,必须再换算一次');
  assert.equal(p.tableId, 'tblWiki1');
});

test('a bare app_token or table id is understood as such', () => {
  assert.deepEqual(parseBitableInput('JHoFbrmTBaTN8nsmoYScZyTpnEb'), {
    appToken: 'JHoFbrmTBaTN8nsmoYScZyTpnEb', tableId: '', nodeToken: '', kind: 'appToken',
  });
  assert.equal(parseBitableInput('tblAbCdEf123456').tableId, 'tblAbCdEf123456');
  assert.equal(parseBitableInput('tblAbCdEf123456').kind, 'tableId');
});

test('nonsense input parses to nothing instead of guessing', () => {
  for (const bad of ['', '   ', '随便一段文字', 'https://example.com/foo', undefined, null]) {
    const p = parseBitableInput(bad);
    assert.equal(p.appToken, '', JSON.stringify(bad));
    assert.equal(p.tableId, '', JSON.stringify(bad));
  }
  // 表 id 一定是 tbl 开头,别把普通单词当表 id
  assert.equal(parseBitableInput('tables').tableId, '');
});

// ---- 找不到目标时把账号里现有的列出来 --------------------------------------

test('lists what the account actually has, so --kv-id / --d1-id can be used', () => {
  assert.deepEqual(kvNamespaceTitles(KV_OUTPUT), ['KEYS', '别的命名空间']);
  assert.deepEqual(d1DatabaseNames(D1_OUTPUT), ['daily-agent-digest-logs', 'unrelated']);
  assert.deepEqual(kvNamespaceTitles('not json'), []);
  assert.deepEqual(d1DatabaseNames(''), []);
});

// ---- 从线上已部署版本读回配置 ----------------------------------------------

const DEPLOYMENTS_STATUS = JSON.stringify({
  id: 'dep-1',
  versions: [
    { version_id: 'v-old-0000', percentage: 0 },
    { version_id: 'v-live-1111', percentage: 100 },
  ],
});

const VERSION_VIEW = JSON.stringify({
  id: 'v-live-1111',
  resources: {
    bindings: [
      { name: 'SUBMIT_URL', type: 'plain_text', text: 'https://daily-agent-digest-submit.real.workers.dev' },
      { name: 'BITABLE_APP_TOKEN', type: 'plain_text', text: 'JHoFbrmTBaTN8nsmoYScZyTpnEb' },
      { name: 'BITABLE_TABLE_ID', type: 'plain_text', text: 'tblRealDaily' },
      { name: 'FEISHU_APP_ID', type: 'plain_text', text: 'cli_realapp' },
      { name: 'KEYS', type: 'kv_namespace', namespace_id: '0123456789abcdef0123456789abcdef' },
      { name: 'DB', type: 'd1', id: 'fedcba98-7654-3210-fedc-ba9876543210' },
      { name: 'FEISHU_APP_SECRET', type: 'secret_text' },
    ],
  },
});

test('the live version is picked by traffic share', () => {
  assert.equal(activeVersionId(DEPLOYMENTS_STATUS), 'v-live-1111');
  assert.equal(activeVersionId('{}'), '');
  assert.equal(activeVersionId('not json'), '');
  assert.equal(activeVersionId(''), '');
});

test('bindings from the deployed version split into vars / kv / d1', () => {
  const b = bindingsFromVersion(VERSION_VIEW);
  assert.equal(b.vars.SUBMIT_URL, 'https://daily-agent-digest-submit.real.workers.dev');
  assert.equal(b.vars.BITABLE_APP_TOKEN, 'JHoFbrmTBaTN8nsmoYScZyTpnEb');
  assert.equal(b.vars.BITABLE_TABLE_ID, 'tblRealDaily');
  assert.equal(b.kv.KEYS, '0123456789abcdef0123456789abcdef');
  assert.equal(b.d1.DB, 'fedcba98-7654-3210-fedc-ba9876543210');
});

test('secrets are never read back', () => {
  const b = bindingsFromVersion(VERSION_VIEW);
  assert.equal(b.vars.FEISHU_APP_SECRET, undefined, 'secret_text 不该被读出来');
  assert.equal(Object.keys(b.vars).includes('FEISHU_APP_SECRET'), false);
});

test('malformed version json yields empty bindings instead of throwing', () => {
  for (const bad of ['', 'null', '{}', 'not json', undefined]) {
    assert.deepEqual(bindingsFromVersion(bad), { vars: {}, kv: {}, d1: {} });
  }
});
