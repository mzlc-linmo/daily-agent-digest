// 签发 Key 时给管理员的提示必须带上「提交地址」:只给 Key 对方没法上报。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { issueReportLines, knownSubmitUrl, resolveSubmitUrl } from '../scripts/issue-report.mjs';

const textOf = (rows) => rows.map(([, text]) => text).join('\n');

test('template placeholders do not count as a real address', () => {
  // wrangler.toml 是随仓库分发的模板;把占位符当真实地址发出去比不显示更糟。
  assert.equal(knownSubmitUrl('https://daily-agent-digest-submit.YOUR_SUBDOMAIN.workers.dev'), '');
  assert.equal(knownSubmitUrl('https://x.REPLACE_WITH_YOUR_SUBDOMAIN.workers.dev'), '');
  assert.equal(knownSubmitUrl('<你的地址>'), '');
  assert.equal(knownSubmitUrl('   '), '');
  assert.equal(knownSubmitUrl(undefined), '');
  assert.equal(knownSubmitUrl('  https://digest.example.workers.dev  '), 'https://digest.example.workers.dev');
});

test('a placeholder address produces the same actionable warning as no address', () => {
  const rows = issueReportLines('张三', { key: 'k' }, knownSubmitUrl('https://x.YOUR_SUBDOMAIN.workers.dev'));
  assert.ok(rows.some(([kind]) => kind === 'warn'), '占位符等同于没有地址,必须警告');
  assert.doesNotMatch(textOf(rows), /提交地址:https/, '不能把占位符当地址打出来');
});

test('a placeholder in wrangler.toml must not shadow the environment variable', () => {
  // 这里曾经写成 knownSubmitUrl(toml || env):toml 里的占位符非空,于是永远短路掉
  // 环境变量里的真实地址,签发时只会显示"不知道地址"。
  assert.equal(
    resolveSubmitUrl('https://daily-agent-digest-submit.YOUR_SUBDOMAIN.workers.dev', 'https://real-team.workers.dev'),
    'https://real-team.workers.dev',
  );
  assert.equal(
    resolveSubmitUrl('https://deployed.workers.dev', 'https://real-team.workers.dev'),
    'https://deployed.workers.dev',
    '部署写入的 toml 值优先于环境变量',
  );
  assert.equal(resolveSubmitUrl('', ''), '');
  assert.equal(resolveSubmitUrl(undefined, undefined), '');
});

test('issued key shows the submission address the member has to fill in', () => {
  const text = textOf(issueReportLines('张三', { key: 'dag_1f7a783f_secret' }, 'https://digest.example.workers.dev'));
  assert.match(text, /dag_1f7a783f_secret/, 'Key 本身要显示');
  assert.match(text, /提交地址/, '要说明这是提交地址');
  assert.match(text, /https:\/\/digest\.example\.workers\.dev/, '要给出真实地址');
  assert.match(text, /「设置」/, '要说明填在哪里');
  assert.match(text, /只显示这一次/, '仍然要提醒 Key 只显示一次');
});

test('address is printed before the do-not-lose-it reminder', () => {
  const rows = issueReportLines('张三', { key: 'k' }, 'https://x.workers.dev');
  const addressAt = rows.findIndex(([, text]) => text.includes('提交地址'));
  const reminderAt = rows.findIndex(([, text]) => text.includes('请立即发给本人'));
  assert.ok(addressAt >= 0 && reminderAt > addressAt, '地址应紧跟在 Key 之后出现');
});

test('missing SUBMIT_URL becomes an actionable warning, not a silent omission', () => {
  const rows = issueReportLines('张三', { key: 'k' }, '');
  const text = textOf(rows);
  assert.ok(rows.some(([kind]) => kind === 'warn'), '缺少地址时要给出警告');
  assert.match(text, /SUBMIT_URL/, '警告要指出是哪个配置项缺失');
  assert.doesNotMatch(text, /提交地址:https/, '没有地址时不能编造一个');
});

test('superseded keys are still reported', () => {
  const text = textOf(issueReportLines('张三', { key: 'k', superseded: ['dag_old_dead'] }, 'https://x.workers.dev'));
  assert.match(text, /dag_old_dead/, '作废的旧 Key 要列出来');
});
