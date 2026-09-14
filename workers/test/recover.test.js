// 配置被清理 / 换机器后,靠这两个解析把已有部署的 id 找回来,不必手抄 32 位 id。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pickD1DatabaseId, pickKvNamespaceId } from '../scripts/recover.mjs';

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
