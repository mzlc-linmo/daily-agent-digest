#!/usr/bin/env node
// 日报上报后端 · 管理 CLI
//
// 安全模型(重要):
//   · Worker 只暴露成员接口(/healthz、/api/v1/me、/api/v1/digests),**没有任何管理接口**;
//   · 所有管理动作(建表、发 Key、撤销、查日志)都在**本机**完成,直连 KV / D1 / 飞书;
//   · 因此不需要管理员口令,门槛是:一台已登录 Cloudflare(wrangler)的机器 + 本机飞书 App Secret;
//   · 代价:Cloudflare 账号权限比"只能发 Key 的口令"大得多,不要把账号访问权给非管理员。
//
//   node workers/scripts/digest-admin.mjs install      # 全流程引导(首次推荐)
//   node workers/scripts/digest-admin.mjs status       # 看配置与登录状态
//   node workers/scripts/digest-admin.mjs feishu       # 配置并校验飞书凭据
//   node workers/scripts/digest-admin.mjs deploy       # 建 KV/D1 + 建日志表 + 部署
//   node workers/scripts/digest-admin.mjs tables       # 建飞书表 → 回填 id → 重新部署 → 配表单
//   node workers/scripts/digest-admin.mjs employees    # 读取员工
//   node workers/scripts/digest-admin.mjs issue        # 选员工生成 Key
//   node workers/scripts/digest-admin.mjs keys         # 列出 Key
//   node workers/scripts/digest-admin.mjs revoke <id>  # 撤销
//   node workers/scripts/digest-admin.mjs logs         # 查审计日志

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  bootstrapLocally, d1Adapter, issueLocally, kvAdapter,
  listKeysLocally, logsLocally, revokeLocally,
} from './local-admin.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOML_PATH = path.join(ROOT, 'wrangler.toml');
const WRANGLER = process.env.WRANGLER_CMD ?? 'npx --yes wrangler';
const KEYCHAIN_SERVICE = 'daily-agent-digest';
// 本机上已有的飞书应用凭据可能挂在别的服务名下,按顺序尝试
const FEISHU_SERVICES = [KEYCHAIN_SERVICE, 'zentao.mzlc.me'];
const D1_NAME = 'daily-agent-digest-logs';

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};
const say = (...a) => console.log(...a);
const ok = (s) => say(`${c.green('✓')} ${s}`);
const warn = (s) => say(`${c.yellow('!')} ${s}`);
/// 管理台里单个操作失败不应终止会话,所以内部一律抛 CliError;只有顶层入口才真正退出。
class CliError extends Error {}
const fail = (msg) => { throw new CliError(msg); };
const die = (msg) => { console.error(`${c.red('✗')} ${msg}`); process.exit(1); };

/* ------------------------------------------------------------ 进程与配置 */

function run(command, args = [], { input, capture = true } = {}) {
  const result = spawnSync(command, args, {
    input, encoding: 'utf8',
    stdio: capture ? ['pipe', 'pipe', 'pipe'] : ['inherit', 'inherit', 'inherit'],
  });
  if (result.error) throw result.error;
  return result;
}

function wrangler(args, { input, quiet = true } = {}) {
  const [cmd, ...base] = WRANGLER.split(' ').filter(Boolean);
  const result = run(cmd, [...base, ...args], { input, capture: quiet });
  return { code: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/// 管理动作的前置条件:必须已登录 Cloudflare。
/// 这正是本设计的安全门槛 —— 没有 wrangler 凭据就动不了后端。
function requireLogin() {
  const r = wrangler(['whoami']);
  const out = r.out ?? '';
  if (r.code !== 0 || /not logged in|expired|CLOUDFLARE_API_TOKEN/i.test(out)) {
    fail(`未登录 Cloudflare。请先执行:\n    ${WRANGLER} login\n  (或在环境变量里设置 CLOUDFLARE_API_TOKEN)`);
  }
  const email = /associated with the email (\S+?)[.\s]/.exec(out)?.[1];
  return { email, raw: out };
}

function readToml() {
  return existsSync(TOML_PATH) ? readFileSync(TOML_PATH, 'utf8') : '';
}

function tomlVar(name) {
  const m = new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, 'm').exec(readToml());
  return m ? m[1] : '';
}

function setTomlVar(name, value) {
  let toml = readToml();
  const line = `${name} = "${value}"`;
  const re = new RegExp(`^${name}\\s*=\\s*".*"$`, 'm');
  if (re.test(toml)) toml = toml.replace(re, line);
  else if (/^\[vars\]$/m.test(toml)) toml = toml.replace(/^\[vars\]$/m, `[vars]\n${line}`);
  else toml += `\n[vars]\n${line}\n`;
  writeFileSync(TOML_PATH, toml);
}

function kvNamespaceId() {
  return /\[\[kv_namespaces\]\][\s\S]*?id\s*=\s*"([0-9a-f]{32})"/.exec(readToml())?.[1] ?? '';
}

function d1DatabaseName() {
  return /\[\[d1_databases\]\][\s\S]*?database_name\s*=\s*"([^"]+)"/.exec(readToml())?.[1] ?? '';
}

function hasBinding(kind) {
  return readToml().includes(`[[${kind}]]`);
}

function appendBinding(block) {
  writeFileSync(TOML_PATH, `${readToml().trimEnd()}\n\n${block.trimEnd()}\n`);
}

/* ---------------------------------------------------------------- 钥匙串 */

function keychainGet(account, services = FEISHU_SERVICES) {
  for (const service of services) {
    const r = run('security', ['find-generic-password', '-s', service, '-a', account, '-w']);
    if (r.status === 0 && r.stdout.trim()) return { value: r.stdout.trim(), service };
  }
  return null;
}

function keychainSet(account, value, service = KEYCHAIN_SERVICE) {
  const r = run('security', ['add-generic-password', '-s', service, '-a', account, '-w', value, '-U']);
  if (r.status !== 0) {
    warn(`写入钥匙串失败(${(r.stderr || '').trim().split('\n')[0]})`);
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ 交互 */

let rl = null;
let stdinEnded = false;
const reader = () => {
  if (!rl) {
    rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.on('close', () => { stdinEnded = true; });
  }
  return rl;
};

/// 读取一行。**输入结束(EOF)时返回空串而不是挂住** —— 管道/重定向场景下不会留下未决 await。
async function ask(question, { defaultValue = '' } = {}) {
  const r = reader();
  if (stdinEnded) return '';
  const suffix = defaultValue ? c.dim(` [${defaultValue}]`) : '';
  const answer = (await Promise.race([
    r.question(`${c.bold('?')} ${question}${suffix}: `),
    new Promise((resolve) => r.once('close', () => resolve(null))),
  ]) ?? '').trim();
  return answer || defaultValue;
}

async function confirm(question, { yes = false } = {}) {
  if (yes) return true;
  const answer = (await ask(`${question} [y/N]`)).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

const closeReader = () => { if (rl) { rl.close(); rl = null; } };

/* ------------------------------------------------------------------ 飞书 */

async function feishuToken(appId, appSecret) {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const body = await res.json();
  if (body.code !== 0) throw new Error(`飞书凭据校验失败:code=${body.code} ${body.msg}`);
  return body.tenant_access_token;
}

async function feishuApi(pathname, token, init = {}) {
  const res = await fetch(`https://open.feishu.cn/open-apis${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8', ...(init.headers ?? {}) },
  });
  return res.json().catch(() => ({}));
}

function resolvedFeishu(flags) {
  const appId = flags['app-id'] || tomlVar('FEISHU_APP_ID') || keychainGet('feishu-app-id')?.value || '';
  const appSecret = flags['app-secret'] || keychainGet('feishu-app-secret')?.value || process.env.FEISHU_APP_SECRET || '';
  return { appId, appSecret };
}

/// 构造共享模块需要的 env(与 Worker 里的 env 形状一致),外加 KV / D1 适配器。
function buildEnv(flags = {}, { withKv = true, withDb = true } = {}) {
  const { appId, appSecret } = resolvedFeishu(flags);
  const env = {
    BITABLE_APP_TOKEN: tomlVar('BITABLE_APP_TOKEN'),
    BITABLE_TABLE_NAME: tomlVar('BITABLE_TABLE_NAME') || '日报明细',
    BITABLE_TABLE_ID: tomlVar('BITABLE_TABLE_ID'),
    REGISTRY_TABLE_ID: tomlVar('REGISTRY_TABLE_ID'),
    REQUEST_TABLE_ID: tomlVar('REQUEST_TABLE_ID'),
    FEISHU_APP_ID: appId,
    FEISHU_APP_SECRET: appSecret,
  };
  if (withKv) {
    const ns = kvNamespaceId();
    if (!ns) fail('wrangler.toml 里没有 KV 绑定,先跑 `deploy`');
    env.KEYS = kvAdapter(ns, wrangler);
  }
  if (withDb) {
    const name = d1DatabaseName();
    if (!name) fail('wrangler.toml 里没有 D1 绑定,先跑 `deploy`');
    env.DB = d1Adapter(name, wrangler);
  }
  return env;
}

async function listEmployees(token, extraBases = []) {
  const files = await feishuApi('/drive/v1/files?page_size=200', token);
  const bases = (files.data?.files ?? []).filter((f) => f.type === 'bitable').map((f) => ({ token: f.token, name: f.name }));
  for (const entry of extraBases) {
    const [baseToken, name] = String(entry).split(':');
    if (baseToken && !bases.some((b) => b.token === baseToken)) bases.push({ token: baseToken, name: name || baseToken });
  }
  const people = new Map();
  for (const base of bases) {
    const tables = (await feishuApi(`/bitable/v1/apps/${base.token}/tables?page_size=100`, token)).data?.items ?? [];
    for (const table of tables) {
      const fields = (await feishuApi(`/bitable/v1/apps/${base.token}/tables/${table.table_id}/fields?page_size=100`, token)).data?.items ?? [];
      const personFields = fields.filter((f) => f.type === 11).map((f) => f.field_name);
      if (!personFields.length) continue;
      const records = (await feishuApi(`/bitable/v1/apps/${base.token}/tables/${table.table_id}/records?page_size=200`, token)).data?.items ?? [];
      for (const record of records) {
        for (const field of personFields) {
          for (const person of record.fields?.[field] ?? []) {
            if (person?.id) people.set(person.id, { name: person.name ?? '(无名)', source: `${base.name}/${table.name}` });
          }
        }
      }
    }
  }
  return [...people].map(([open_id, v]) => ({ open_id, ...v })).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

async function fetchEmployees(flags) {
  const { appId, appSecret } = resolvedFeishu(flags);
  if (!appId || !appSecret) fail('缺飞书凭据:先跑 `feishu`');
  const token = await feishuToken(appId, appSecret);
  const extra = (flags['scan-bases'] || process.env.DIGEST_SCAN_BASES || tomlVar('SCAN_BASES') || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return listEmployees(token, extra);
}

/* ------------------------------------------------------------------ 命令 */

async function cmdStatus() {
  const feishu = resolvedFeishu({});
  const login = wrangler(['whoami']);
  const loggedIn = login.code === 0 && !/not logged in|expired|CLOUDFLARE_API_TOKEN/i.test(login.out ?? '');
  const rows = [
    ['Cloudflare 登录', loggedIn ? c.green('已登录') : c.red('未登录(需要 wrangler login)')],
    ['飞书 App ID', tomlVar('FEISHU_APP_ID') ? c.green('已配置') : c.red('缺失')],
    ['飞书 App Secret', feishu.appSecret ? c.green('已配置(钥匙串/环境变量)') : c.red('缺失')],
    ['KV 命名空间', hasBinding('kv_namespaces') ? c.green('已绑定') : c.red('缺失')],
    ['D1 数据库', hasBinding('d1_databases') ? c.green('已绑定') : c.red('缺失')],
    ['主表 ID', tomlVar('BITABLE_TABLE_ID') || c.red('缺失')],
    ['登记表 ID', tomlVar('REGISTRY_TABLE_ID') || c.red('缺失')],
    ['申请表 ID', tomlVar('REQUEST_TABLE_ID') || c.red('缺失')],
    ['定时任务', /crons\s*=/.test(readToml()) ? c.green('每分钟') : c.red('未配置')],
  ];
  say(c.bold('\n当前配置'));
  for (const [k, v] of rows) say(`  ${k.padEnd(16)} ${v}`);
  const url = tomlVar('SUBMIT_URL') || process.env.DIGEST_SUBMIT_URL || '';
  if (url) {
    const r = run('curl', ['-sS', `${url.replace(/\/$/, '')}/healthz`]);
    say(`  ${'后端地址'.padEnd(16)} ${url}`);
    say(`  ${'后端健康'.padEnd(16)} ${r.status === 0 ? r.stdout.trim().replace(/\s+/g, ' ') : c.red('不可达')}`);
  } else {
    say(`  ${'后端地址'.padEnd(16)} ${c.red('未知(部署后写入 wrangler.toml 的 SUBMIT_URL)')}`);
  }
  say(c.dim('  管理动作在本机执行,不需要管理员口令。\n'));
}

async function cmdFeishu(flags) {
  requireLogin();
  let appId = flags['app-id'] || tomlVar('FEISHU_APP_ID') || keychainGet('feishu-app-id')?.value || '';
  let appSecret = flags['app-secret'] || keychainGet('feishu-app-secret')?.value || '';

  if (!appId) appId = await ask('飞书 App ID (cli_…)');
  if (!appId.startsWith('cli_')) fail(`App ID 看起来不对:${appId}(应以 cli_ 开头)`);
  if (!appSecret) appSecret = await ask('飞书 App Secret(也可先存进钥匙串)');
  if (!appSecret) fail('缺少 App Secret');

  process.stdout.write(c.dim('  正在校验凭据…\n'));
  await feishuToken(appId, appSecret);
  ok(`飞书凭据有效(App ID ${appId.slice(0, 12)}…)`);

  setTomlVar('FEISHU_APP_ID', appId);
  ok('已写入 wrangler.toml 的 FEISHU_APP_ID');
  if (await confirm('把凭据存进本机钥匙串,以后免输入?', { yes: flags.yes })) {
    keychainSet('feishu-app-id', appId);
    if (keychainSet('feishu-app-secret', appSecret)) ok(`已存入钥匙串(service=${KEYCHAIN_SERVICE})`);
  }
  process.stdout.write(c.dim('  正在写入 Worker secret FEISHU_APP_SECRET…\n'));
  const r = wrangler(['secret', 'put', 'FEISHU_APP_SECRET'], { input: appSecret });
  if (r.code !== 0) fail(`写入 secret 失败:${r.out.trim()}`);
  ok('FEISHU_APP_SECRET 已写入 Cloudflare');
}

async function cmdDeploy(flags) {
  requireLogin();
  if (!hasBinding('kv_namespaces')) {
    process.stdout.write(c.dim('  创建 KV 命名空间 KEYS…\n'));
    const r = wrangler(['kv', 'namespace', 'create', 'KEYS']);
    const id = /id\s*=\s*"([0-9a-f]{32})"/.exec(r.out ?? '')?.[1];
    if (!id) fail(`创建 KV 失败:${(r.out ?? '').trim()}`);
    appendBinding(`# API Key 存放在 KV:签发时绑定人员,撤销即时生效。\n[[kv_namespaces]]\nbinding = "KEYS"\nid = "${id}"`);
    ok(`KV 已创建并写入 wrangler.toml(${id})`);
  } else ok('KV 已绑定,跳过');

  if (!hasBinding('d1_databases')) {
    process.stdout.write(c.dim('  创建 D1 数据库…\n'));
    const r = wrangler(['d1', 'create', D1_NAME]);
    const id = /database_id\s*=\s*"([0-9a-f-]{36})"/.exec(r.out ?? '')?.[1];
    if (!id) fail(`创建 D1 失败:${(r.out ?? '').trim()}`);
    appendBinding(`# 审计日志(提交/签发/撤销)持久化在 D1。\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "${D1_NAME}"\ndatabase_id = "${id}"`);
    ok(`D1 已创建并写入 wrangler.toml(${id})`);
  } else ok('D1 已绑定,跳过');

  process.stdout.write(c.dim('  应用 schema.sql…\n'));
  const schema = wrangler(['d1', 'execute', D1_NAME, '--remote', '--file=schema.sql']);
  if (schema.code !== 0) fail(`建表失败:${(schema.out ?? '').trim()}`);
  ok('audit_log 表已就绪');

  process.stdout.write(c.dim('  部署 Worker…\n'));
  const deploy = wrangler(['deploy']);
  if (deploy.code !== 0) fail(`部署失败:${(deploy.out ?? '').trim()}`);
  const url = /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(deploy.out ?? '')?.[0];
  if (url) { setTomlVar('SUBMIT_URL', url); ok(`后端已部署:${url}`); }
  else warn('部署成功但没解析到地址,请手动把 SUBMIT_URL 写进 wrangler.toml');
}

async function cmdTables(flags) {
  requireLogin();
  const env = buildEnv(flags, { withKv: true, withDb: true });
  process.stdout.write(c.dim('  直连飞书建表/建字段…\n'));
  const result = await bootstrapLocally(env);
  ok(`主表 ${result.tableId} / 登记表 ${result.registryTableId} / 申请表 ${result.requestTableId}`);
  if (result.created.length) say(c.dim(`    新建:${result.created.join(', ')}`));

  setTomlVar('BITABLE_TABLE_ID', result.tableId);
  setTomlVar('REGISTRY_TABLE_ID', result.registryTableId);
  setTomlVar('REQUEST_TABLE_ID', result.requestTableId);
  ok('table id 已写回 wrangler.toml');

  process.stdout.write(c.dim('  重新部署以让 Worker 读到这些 id…\n'));
  const deploy = wrangler(['deploy']);
  if (deploy.code !== 0) fail(`部署失败:${(deploy.out ?? '').trim()}`);
  ok('已重新部署');

  if (flags['skip-form']) { warn('按要求跳过表单配置'); return; }
  await setupForm(flags);
}

/// 把「密钥申请」表配成:表单只问「申请人」,并开启分享;同时收紧 base 可见范围。
async function setupForm(flags) {
  const { appId, appSecret } = resolvedFeishu(flags);
  if (!appId || !appSecret) { warn('缺飞书凭据,跳过表单配置'); return; }
  const token = await feishuToken(appId, appSecret);
  const baseToken = tomlVar('BITABLE_APP_TOKEN');
  const table = tomlVar('REQUEST_TABLE_ID');
  if (!baseToken || !table) { warn('缺 base/表 id,跳过表单配置'); return; }

  const views = (await feishuApi(`/bitable/v1/apps/${baseToken}/tables/${table}/views?page_size=50`, token)).data?.items ?? [];
  let form = views.find((v) => v.view_type === 'form');
  if (!form) {
    const created = await feishuApi(`/bitable/v1/apps/${baseToken}/tables/${table}/views`, token, {
      method: 'POST', body: JSON.stringify({ view_name: '密钥申请表单', view_type: 'form' }),
    });
    if (created.code !== 0) { warn(`建表单视图失败:${created.msg}`); return; }
    form = created.data?.view;
    ok(`表单视图已创建(${form.view_id})`);
  } else ok(`复用已有表单视图(${form.view_id})`);

  const fields = (await feishuApi(`/bitable/v1/apps/${baseToken}/tables/${table}/fields?page_size=100`, token)).data?.items ?? [];
  const nameOf = Object.fromEntries(fields.map((f) => [f.field_id, f.field_name]));
  const formPath = `/bitable/v1/apps/${baseToken}/tables/${table}/forms/${form.view_id}`;
  for (const item of (await feishuApi(`${formPath}/fields`, token)).data?.items ?? []) {
    if (nameOf[item.field_id] === '申请人') {
      await feishuApi(`${formPath}/fields/${item.field_id}`, token, { method: 'PATCH', body: JSON.stringify({ visible: true, required: true }) });
      continue;
    }
    if (item.visible === false && item.required === false) continue;
    // 隐藏字段不允许直接改 required:先显示并取消必填,再隐藏
    if (item.required) {
      await feishuApi(`${formPath}/fields/${item.field_id}`, token, { method: 'PATCH', body: JSON.stringify({ visible: true, required: false }) });
    }
    await feishuApi(`${formPath}/fields/${item.field_id}`, token, { method: 'PATCH', body: JSON.stringify({ visible: false }) });
  }
  ok('表单只保留「申请人」');

  const shared = await feishuApi(formPath, token, { method: 'PATCH', body: JSON.stringify({ shared: true }) });
  const url = shared.data?.form?.shared_url;
  if (url) ok(`表单地址:${url}`); else warn(`表单分享开启失败:${shared.msg ?? ''}`);

  const closed = await feishuApi(`/drive/v1/permissions/${baseToken}/public?type=bitable`, token, {
    method: 'PATCH', body: JSON.stringify({ link_share_entity: 'closed' }),
  });
  ok(closed.code === 0 ? 'base 链接分享已关闭(Key 只有管理员可见)' : `关闭链接分享失败:${closed.msg}`);

  const adminOpenId = flags['admin-open-id'] || process.env.DIGEST_ADMIN_OPEN_ID;
  if (adminOpenId) {
    const added = await feishuApi(`/drive/v1/permissions/${baseToken}/members?type=bitable&need_notification=false`, token, {
      method: 'POST', body: JSON.stringify({ member_type: 'openid', member_id: adminOpenId, perm: 'full_access' }),
    });
    ok(added.code === 0 ? '管理员已加为 base 协作者' : `添加协作者失败:${added.msg}`);
  } else {
    warn('未提供 --admin-open-id,跳过"把管理员加为协作者"');
  }
}

async function cmdEmployees(flags) {
  const people = await fetchEmployees(flags);
  if (!people.length) fail('没找到任何员工(人员字段为空?)');
  say(c.bold(`\n共 ${people.length} 人`));
  for (const p of people) say(`  ${p.name.padEnd(14)} ${p.open_id}   ${c.dim(p.source)}`);
  say('');
}

async function cmdIssue(flags) {
  requireLogin();
  const env = buildEnv(flags);

  if (flags['open-id']) {
    const memberId = flags['member-id'] || await ask('成员ID(工号/账号)', { defaultValue: String(flags['open-id']).slice(-6) });
    const name = flags.name || await ask('姓名');
    return reportIssue(name, await issueLocally(env, { member_id: memberId, member: name, open_id: flags['open-id'] }));
  }
  if (flags.email) {
    const name = flags.name || await ask('姓名');
    const memberId = flags['member-id'] || await ask('成员ID(工号/账号)');
    return reportIssue(name, await issueLocally(env, { member_id: memberId, member: name, email: flags.email }));
  }

  const people = await fetchEmployees(flags);
  if (!people.length) fail('没找到员工');
  say(c.bold('\n选择员工(可多选,如 1,3,5)'));
  people.forEach((p, i) => say(`  ${String(i + 1).padStart(2)}. ${p.name.padEnd(14)} ${c.dim(p.source)}`));
  const picks = (await ask('序号')).split(/[,，\s]+/).map((s) => Number(s) - 1).filter((i) => people[i]);
  if (!picks.length) fail('没有选中任何人');
  for (const i of picks) {
    const person = people[i];
    const mid = await ask(`「${person.name}」的成员ID(工号/账号)`, { defaultValue: person.open_id.slice(-6) });
    reportIssue(person.name, await issueLocally(env, { member_id: mid, member: person.name, open_id: person.open_id }));
  }
}

function reportIssue(label, issued) {
  ok(`「${label}」的 Key(只显示这一次):`);
  say(`    ${c.bold(issued.key)}`);
  if (issued.superseded?.length) say(c.dim(`    已作废旧 Key:${issued.superseded.join(', ')}(一人一把)`));
}

async function cmdKeys(flags) {
  requireLogin();
  const keys = await listKeysLocally(buildEnv(flags, { withDb: false }));
  say(c.bold(`\n共 ${keys.length} 把 Key`));
  for (const k of keys) {
    const state = k.enabled ? c.green('启用') : c.dim('已撤销');
    say(`  ${k.key_id}  ${String(k.member).padEnd(14)} ${String(k.member_id).padEnd(12)} ${state}  ${c.dim(k.created_at ?? '')}`);
  }
  say('');
}

async function cmdRevoke(flags) {
  requireLogin();
  const keyId = flags._[0];
  if (!keyId) fail('用法:revoke <key_id>');
  const revoked = await revokeLocally(buildEnv(flags, { withDb: false }), keyId);
  ok(`已撤销 ${revoked.key_id}(${revoked.member ?? ''}),下一次请求立即失效`);
}

async function cmdLogs(flags) {
  requireLogin();
  const rows = await logsLocally(buildEnv(flags, { withKv: false }), {
    limit: flags.limit ?? 100,
    memberId: flags.member,
    date: flags.date,
    event: flags.event,
    outcome: flags.outcome,
  });
  say(c.bold(`\n共 ${rows.length} 条`));
  for (const row of rows) {
    const tag = row.outcome === 'ok' ? c.green('ok  ') : c.red('err ');
    const detail = row.outcome === 'ok'
      ? `mode=${row.mode ?? '-'} items=${row.items ?? '-'}`
      : `err=${row.error_code ?? '-'} ${String(row.error_message ?? '').slice(0, 60)}`;
    say(`  ${String(row.ts).slice(0, 19).replace('T', ' ')} ${tag} ${String(row.event).padEnd(10)} ${String(row.member_id ?? '-').padEnd(12)} ${detail}`);
  }
  say('');
}

async function cmdInstall(flags) {
  say(c.bold('\n日报上报后端 · 安装向导'));
  say(c.dim('管理动作全部在本机执行,需要先登录 Cloudflare;已完成的步骤会自动跳过。\n'));
  requireLogin();
  await cmdStatus();

  const steps = [
    ['配置飞书应用凭据', () => cmdFeishu(flags)],
    ['创建 KV/D1 并部署后端', () => cmdDeploy(flags)],
    ['建飞书表并回填 table id', () => cmdTables(flags)],
  ];
  for (const [label, fn] of steps) {
    if (!(await confirm(`执行「${label}」?`, { yes: flags.yes }))) { warn(`跳过「${label}」`); continue; }
    say(c.bold(`\n▶ ${label}`));
    await fn();
  }

  say(c.bold('\n▶ 读取员工'));
  const people = await fetchEmployees(flags);
  say(`  共 ${people.length} 人`);
  if (people.length && await confirm('现在为员工签发 Key?', { yes: false })) await cmdIssue(flags);

  await cmdStatus();
  say('完成。下一步:把后端地址 + Key 填进 App 的「设置」面板。\n');
}

/* ---------------------------------------------------------------- 管理台 */

/// 管理台里撤销 Key:先列出启用中的 Key 让管理员挑,不用手输 key_id。
async function cmdRevokeMenu(flags) {
  requireLogin();
  const env = buildEnv(flags, { withDb: false });
  const keys = (await listKeysLocally(env)).filter((k) => k.enabled);
  if (!keys.length) { warn('当前没有启用中的 Key'); return; }
  say(c.bold('\n启用中的 Key:'));
  keys.forEach((k, i) => say(`  ${String(i + 1).padStart(2)}. ${k.key_id}  ${String(k.member).padEnd(14)} ${c.dim(k.member_id)}`));
  const answer = (await ask('要撤销的编号(或直接输入 key_id,留空取消)')).trim();
  if (!answer) { warn('已取消'); return; }
  const keyId = keys[Number(answer) - 1]?.key_id ?? answer;
  const revoked = await revokeLocally(buildEnv(flags, { withDb: false }), keyId);
  ok(`已撤销 ${revoked.key_id}(${revoked.member ?? ''}),下一次请求立即失效`);
}

/// 管理台里按条件查日志:逐项询问,留空即不限制。
async function cmdLogsMenu(flags) {
  const member = (await ask('成员ID(留空=全部)')).trim();
  const date = (await ask('日期 YYYY-MM-DD(留空=全部)')).trim();
  const outcome = (await ask('结果 ok/error(留空=全部)')).trim();
  await cmdLogs({
    ...flags,
    member: member || undefined,
    date: date || undefined,
    outcome: outcome || undefined,
    limit: flags.limit ?? 50,
  });
}

/// 管理项目录:管理员按编号选择,执行完回到菜单。
const MENU_SECTIONS = [
  ['初次安装', [
    ['一键全流程(校验凭据 → 部署 → 建表 → 读取员工)', (f) => cmdInstall(f)],
  ]],
  ['配置与部署', [
    ['查看状态(配置 / Cloudflare 登录 / 后端健康)', (f) => cmdStatus(f)],
    ['配置飞书应用凭据(App ID / Secret)', (f) => cmdFeishu(f)],
    ['创建 KV / D1 并部署 Worker', (f) => cmdDeploy(f)],
    ['建飞书表并回填 table id(含配置申请表单)', (f) => cmdTables(f)],
  ]],
  ['成员与 Key', [
    ['列出员工(含 open_id)', (f) => cmdEmployees(f)],
    ['为员工签发 Key', (f) => cmdIssue(f)],
    ['列出已签发的 Key', (f) => cmdKeys(f)],
    ['撤销某把 Key', (f) => cmdRevokeMenu(f)],
  ]],
  ['审计日志', [
    ['查看最近日志', (f) => cmdLogs({ ...f, limit: 20 })],
    ['按条件查日志(成员 / 日期 / 成功失败)', (f) => cmdLogsMenu(f)],
  ]],
];

async function cmdMenu(flags) {
  // 扁平化成"编号 → 动作",同时保留分组标题
  const items = [];
  for (const [section, entries] of MENU_SECTIONS) {
    items.push({ section });
    for (const [label, run] of entries) items.push({ number: items.filter((i) => i.number).length + 1, label, run });
  }

  say(c.bold('\n日报上报后端 · 管理台'));
  say(c.dim('  管理动作在本机执行(直连 KV / D1 / 飞书),需要已登录 Cloudflare;Worker 上没有任何管理接口。'));
  for (;;) {
    say('');
    for (const item of items) {
      if (item.section) say(c.dim(`  ── ${item.section} ──`));
      else say(`  ${String(item.number).padStart(3)}) ${item.label}`);
    }
    say(`  ${String(0).padStart(3)}) 退出`);
    const answer = (await ask('请选择编号')).trim().toLowerCase();
    if (!answer || ['0', 'q', 'quit', 'exit'].includes(answer)) { say('已退出。'); return; }
    const target = items.find((i) => String(i.number) === answer);
    if (!target) { warn(`没有编号 ${answer},请重新选择`); continue; }
    say('');
    try {
      await target.run(flags);
    } catch (err) {
      // 单个操作失败(含未登录、缺配置)只提示,不退出管理台
      if (err instanceof CliError) warn(err.message);
      else { warn(`执行出错:${err.message ?? err}`); }
    }
  }
}

/* -------------------------------------------------------------------- 入口 */

function parseArgs(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [key, inlineValue] = arg.slice(2).split('=');
      if (inlineValue !== undefined) flags[key] = inlineValue;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) { flags[key] = argv[i + 1]; i += 1; }
      else flags[key] = true;
    } else flags._.push(arg);
  }
  return flags;
}

const COMMANDS = {
  menu: cmdMenu,
  install: cmdInstall,
  status: cmdStatus,
  feishu: cmdFeishu,
  deploy: cmdDeploy,
  tables: cmdTables,
  employees: cmdEmployees,
  issue: cmdIssue,
  keys: cmdKeys,
  revoke: cmdRevoke,
  logs: cmdLogs,
};

const argv = process.argv.slice(2);
const explicit = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
// 交互式终端下直接进管理台;管道/脚本场景退回 status,避免挂住
const command = explicit ?? (process.stdin.isTTY ? 'menu' : 'status');
const flags = parseArgs(explicit ? argv.slice(1) : argv);

if (!COMMANDS[command] || flags.help) {
  say(`日报上报后端管理 CLI

用法:node workers/scripts/digest-admin.mjs <命令> [选项]

命令:
  menu             管理台:列出全部管理项目,按编号选择(交互终端下的默认命令)
  install          全流程引导(非交互等价于 menu 的一次性版本)
  status           显示配置与 Cloudflare 登录状态
  feishu           配置并校验飞书应用凭据(App ID/Secret)
  deploy           创建 KV + D1、应用日志表结构、部署 Worker
  tables           建飞书表 → 回填 table id → 重新部署 → 配置表单
  employees        读取员工(含 open_id)
  issue            选员工生成 Key(交互式;或 --open-id/--email/--name/--member-id)
  keys             列出已签发的 Key
  revoke <key_id>  撤销某把 Key
  logs             查询审计日志(--member/--date/--event/--outcome/--limit)

安全:本 CLI 没有"管理员口令" —— 建表/发 Key/撤销/查日志都在本机直连 KV/D1/飞书,
      前提是已登录 Cloudflare(wrangler login 或 CLOUDFLARE_API_TOKEN)+ 本机飞书 App Secret。
      Worker 上不存在任何管理接口。

选项:
  --yes                  全部确认(非交互)
  --app-id/--app-secret  直接给飞书凭据
  --admin-open-id        配置表单时把该用户加为 base 协作者
  --scan-bases token:名  额外扫描的 base(员工在别人共享的表里时用)
  --skip-form            只建表,不配置表单

环境变量:WRANGLER_CMD(默认 "npx --yes wrangler")、DIGEST_SUBMIT_URL、DIGEST_SCAN_BASES、CLOUDFLARE_API_TOKEN
`);
  process.exit(flags.help ? 0 : 1);
}

try {
  await COMMANDS[command](flags);
} catch (err) {
  // 只有走到这里才真正退出;管理台内部用 CliError 承接,不会中断会话
  die(err instanceof CliError ? err.message : (err.stack ?? String(err)));
} finally {
  closeReader();
}
