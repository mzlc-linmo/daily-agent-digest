#!/usr/bin/env node
// 日报上报后端的一站式管理 CLI。
//
//   node workers/scripts/digest-admin.mjs install       # 全流程引导(推荐首次使用)
//   node workers/scripts/digest-admin.mjs status        # 看当前配置缺什么
//   node workers/scripts/digest-admin.mjs feishu        # 配置并校验飞书应用凭据
//   node workers/scripts/digest-admin.mjs admin-token   # 配置管理员口令
//   node workers/scripts/digest-admin.mjs deploy        # 建 KV/D1 + 建日志表 + 部署 Worker
//   node workers/scripts/digest-admin.mjs tables        # 建飞书表 → 回写 table id → 重新部署 → 配表单
//   node workers/scripts/digest-admin.mjs employees     # 读取员工(从飞书表格的人员字段)
//   node workers/scripts/digest-admin.mjs issue         # 选员工生成 Key(交互式)
//   node workers/scripts/digest-admin.mjs keys          # 列出已签发的 Key
//   node workers/scripts/digest-admin.mjs revoke <id>   # 撤销
//   node workers/scripts/digest-admin.mjs logs          # 查审计日志(D1)
//
// 设计取舍:
//   · 每一步都能单独重跑(幂等),`install` 只是把它们按顺序串起来;
//   · 所有交互都可以用命令行参数替代,便于脚本化与自动化测试;
//   · 密钥只经 stdin 交给 wrangler,不落盘、不打印。

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOML_PATH = path.join(ROOT, 'wrangler.toml');
const SCHEMA_PATH = path.join(ROOT, 'schema.sql');
const WRANGLER = process.env.WRANGLER_CMD ?? 'npx --yes wrangler';
const KEYCHAIN_SERVICE = 'daily-agent-digest';
// 本机上已有的飞书应用凭据可能挂在别的服务名下(例如自研系统的集成),按顺序尝试。
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
const die = (s) => { console.error(`${c.red('✗')} ${s}`); process.exit(1); };

/* ---------------------------------------------------------------- 基础设施 */

function run(command, args = [], { input, capture = true } = {}) {
  const result = spawnSync(command, args, {
    input,
    encoding: 'utf8',
    stdio: capture ? ['pipe', 'pipe', 'pipe'] : ['inherit', 'inherit', 'inherit'],
    shell: false,
  });
  if (result.error) throw result.error;
  return result;
}

/// 调用 wrangler(命令串允许带参数,例如 npx --yes wrangler)
function wrangler(args, { input, quiet = false } = {}) {
  const [cmd, ...base] = WRANGLER.split(' ').filter(Boolean);
  const result = run(cmd, [...base, ...args], { input, capture: quiet });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return { code: result.status, out };
}

function keychainGet(account, services = FEISHU_SERVICES) {
  for (const service of services) {
    const r = run('security', ['find-generic-password', '-s', service, '-a', account, '-w']);
    if (r.status === 0 && r.stdout.trim()) return { value: r.stdout.trim(), service };
  }
  return null;
}

function keychainSet(account, value, service = KEYCHAIN_SERVICE) {
  // -U 表示已存在则更新;-w 从参数取值(本机钥匙串,权限 0600 级别保护)
  const r = run('security', ['add-generic-password', '-s', service, '-a', account, '-w', value, '-U']);
  if (r.status !== 0) {
    warn(`写入钥匙串失败(${(r.stderr || '').trim().split('\n')[0]})—— 值仍可用于本次操作,但下次需要重新输入`);
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ 配置读写 */

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

function hasBinding(kind) {
  return readToml().includes(`[[${kind}]]`);
}

function appendBinding(block) {
  writeFileSync(TOML_PATH, `${readToml().trimEnd()}\n\n${block.trimEnd()}\n`);
}

/* -------------------------------------------------------------------- 交互 */

let rl = null;
function reader() {
  if (!rl) rl = createInterface({ input: process.stdin, output: process.stdout });
  return rl;
}

async function ask(question, { defaultValue = '', secret = false } = {}) {
  const suffix = defaultValue ? c.dim(` [${defaultValue}]`) : '';
  const answer = (await reader().question(`${c.bold('?')} ${question}${suffix}: `)).trim();
  return answer || defaultValue;
}

async function confirm(question, { yes = false } = {}) {
  if (yes) return true;
  const answer = (await reader().question(`${c.bold('?')} ${question} [y/N]: `)).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

function closeReader() {
  if (rl) { rl.close(); rl = null; }
}

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

async function feishuApi(path, token, init = {}) {
  const res = await fetch(`https://open.feishu.cn/open-apis${path}`, {
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

/// 从飞书表格的人员字段里读出员工列表(open_id 是签发 Key 的必需信息)。
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

/* ------------------------------------------------------------------ 管理端 */

function submitUrl() {
  return process.env.DIGEST_SUBMIT_URL || tomlVar('SUBMIT_URL') || '';
}

function adminToken(flags = {}) {
  return flags['admin-token'] || process.env.ADMIN_TOKEN || keychainGet('admin-token', [KEYCHAIN_SERVICE])?.value || '';
}

async function adminApi(pathname, { token, method = 'GET', body } = {}) {
  const base = submitUrl();
  if (!base) die('还不知道后端地址:先跑 `deploy` 与 `tables`,或设置 DIGEST_SUBMIT_URL');
  if (!token) die('缺少管理员口令:先跑 `admin-token`,或设置 ADMIN_TOKEN');
  const res = await fetch(`${base.replace(/\/$/, '')}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await text0(res);
  return { status: res.status, body: text };
}

async function text0(res) {
  const raw = await res.text();
  try { return JSON.parse(raw); } catch { return raw; }
}

/* ------------------------------------------------------------------ 各步骤 */

async function cmdStatus() {
  const toml = readToml();
  const feishu = resolvedFeishu({});
  const rows = [
    ['飞书 App ID', tomlVar('FEISHU_APP_ID') ? c.green('已配置') : c.red('缺失')],
    ['飞书 App Secret', feishu.appSecret ? c.green('已配置(钥匙串/环境变量)') : c.red('缺失')],
    ['KV 命名空间', hasBinding('kv_namespaces') ? c.green('已绑定') : c.red('缺失')],
    ['D1 数据库', hasBinding('d1_databases') ? c.green('已绑定') : c.red('缺失')],
    ['管理员口令', adminToken() ? c.green('已配置') : c.red('缺失(用 admin-token --local-only 存本机)')],
    ['主表 ID', tomlVar('BITABLE_TABLE_ID') || c.red('缺失')],
    ['登记表 ID', tomlVar('REGISTRY_TABLE_ID') || c.red('缺失')],
    ['申请表 ID', tomlVar('REQUEST_TABLE_ID') || c.red('缺失')],
    ['定时任务', /crons\s*=/.test(toml) ? c.green('每分钟') : c.red('未配置')],
  ];
  say(c.bold('\n当前配置'));
  for (const [k, v] of rows) say(`  ${k.padEnd(16)} ${v}`);
  const base = submitUrl();
  if (base) {
    const r = run('curl', ['-sS', `${base.replace(/\/$/, '')}/healthz`]);
    say(`  ${'后端健康'.padEnd(16)} ${r.status === 0 ? r.stdout.trim() : c.red('不可达')}`);
    say(`  ${'后端地址'.padEnd(16)} ${base}`);
  } else {
    say(`  ${'后端地址'.padEnd(16)} ${c.red('未知(部署后写入 wrangler.toml 的 SUBMIT_URL)')}`);
  }
  say('');
}

async function cmdFeishu(flags) {
  let appId = flags['app-id'] || tomlVar('FEISHU_APP_ID') || keychainGet('feishu-app-id')?.value || '';
  let appSecret = flags['app-secret'] || keychainGet('feishu-app-secret')?.value || '';

  if (!appId) appId = await ask('飞书 App ID (cli_…)');
  if (!appId.startsWith('cli_')) die(`App ID 看起来不对:${appId}(应以 cli_ 开头)`);
  if (!appSecret) {
    appSecret = await ask('飞书 App Secret(输入不回显,也可先存进钥匙串)', { secret: true });
  }
  if (!appSecret) die('缺少 App Secret');

  process.stdout.write(c.dim('  正在校验凭据…\n'));
  await feishuToken(appId, appSecret);
  ok(`飞书凭据有效(App ID ${appId.slice(0, 12)}…)`);

  setTomlVar('FEISHU_APP_ID', appId);
  ok('已写入 wrangler.toml 的 FEISHU_APP_ID');

  if (await confirm('把 App Secret 存进本机钥匙串,以后免输入?', { yes: flags.yes })) {
    keychainSet('feishu-app-id', appId);
    if (keychainSet('feishu-app-secret', appSecret)) ok(`已存入钥匙串(service=${KEYCHAIN_SERVICE})`);
  }
  // 交给 wrangler 存成 Worker secret(经 stdin,不落盘)
  process.stdout.write(c.dim('  正在写入 Worker secret FEISHU_APP_SECRET…\n'));
  const r = wrangler(['secret', 'put', 'FEISHU_APP_SECRET'], { input: appSecret });
  if (r.code !== 0) die(`写入 secret 失败:${r.out.trim()}`);
  ok('FEISHU_APP_SECRET 已写入 Cloudflare');
}

async function cmdAdminToken(flags) {
  const existing = adminToken({});
  // 非交互(--yes)且本机已有口令:绝不再写 Cloudflare,否则会把线上口令覆盖成随机值
  if (flags.yes && !flags['admin-token'] && !flags['local-only'] && existing) {
    warn('本机已有管理员口令,非交互模式下不再改动 Cloudflare(需要改口令请显式跑 admin-token)');
    return;
  }

  let localOnly = Boolean(flags['local-only']);
  if (!localOnly && !flags.yes && !flags['admin-token']) {
    const mode = await ask(
      existing
        ? '口令怎么处理?1=新建并写入 Cloudflare(覆盖现有) 2=已有口令,只存本机'
        : '口令怎么处理?1=新建并写入 Cloudflare 2=已有口令,只存本机',
      { defaultValue: existing ? '2' : '1' },
    );
    localOnly = mode.trim() === '2';
  }

  let token = flags['admin-token'] || process.env.NEW_ADMIN_TOKEN || '';
  if (!token && localOnly) token = await ask('输入你已在 Cloudflare 上设好的管理员口令');

  if (!token) {
    const generated = Array.from(crypto.getRandomValues(new Uint8Array(24)))
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    say(`  可以直接用下面这个随机口令:\n    ${c.bold(generated)}`);
    token = await ask('管理员口令', { defaultValue: generated });
  }
  if (token.length < 12) die('口令太短,至少 12 位');

  if (localOnly) {
    // 已经用 wrangler secret put 设过口令时用这个:只把口令存到本机,避免覆盖线上
    if (keychainSet('admin-token', token)) ok('已存入本机钥匙串(未改动 Cloudflare 上的口令)');
    else warn('钥匙串写入失败,可用环境变量 ADMIN_TOKEN 代替');
    return;
  }

  process.stdout.write(c.dim('  正在写入 Worker secret ADMIN_TOKEN…\n'));
  const r = wrangler(['secret', 'put', 'ADMIN_TOKEN'], { input: token });
  if (r.code !== 0) die(`写入 secret 失败:${r.out.trim()}`);
  ok('ADMIN_TOKEN 已写入 Cloudflare');
  if (keychainSet('admin-token', token)) ok('已存入本机钥匙串,后续命令免输入');
}

async function cmdDeploy(flags) {
  // 1) KV:存 API Key
  if (!hasBinding('kv_namespaces')) {
    process.stdout.write(c.dim('  创建 KV 命名空间 KEYS…\n'));
    const r = wrangler(['kv', 'namespace', 'create', 'KEYS']);
    const id = /id\s*=\s*"([0-9a-f]{32})"/.exec(r.out)?.[1];
    if (!id) die(`创建 KV 失败:${r.out.trim()}`);
    appendBinding(`# API Key 存放在 KV:签发时绑定人员,撤销即时生效。\n[[kv_namespaces]]\nbinding = "KEYS"\nid = "${id}"`);
    ok(`KV 已创建并写入 wrangler.toml(id ${id})`);
  } else ok('KV 已绑定,跳过');

  // 2) D1:审计日志
  if (!hasBinding('d1_databases')) {
    process.stdout.write(c.dim('  创建 D1 数据库…\n'));
    const r = wrangler(['d1', 'create', D1_NAME]);
    const id = /database_id\s*=\s*"([0-9a-f-]{36})"/.exec(r.out)?.[1];
    if (!id) die(`创建 D1 失败:${r.out.trim()}\n提示:同名库已存在时,直接在 wrangler.toml 里补 [[d1_databases]] 即可`);
    appendBinding(`# 审计日志(提交/签发/撤销)持久化在 D1。\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "${D1_NAME}"\ndatabase_id = "${id}"`);
    ok(`D1 已创建并写入 wrangler.toml(${id})`);
  } else ok('D1 已绑定,跳过');

  // 3) 审计日志表结构
  process.stdout.write(c.dim('  应用 schema.sql…\n'));
  const schema = wrangler(['d1', 'execute', D1_NAME, '--remote', '--file=schema.sql']);
  if (schema.code !== 0) die(`建表失败:${schema.out.trim()}`);
  ok('audit_log 表已就绪');

  // 4) 部署
  process.stdout.write(c.dim('  部署 Worker…\n'));
  const deploy = wrangler(['deploy']);
  if (deploy.code !== 0) die(`部署失败:${deploy.out.trim()}`);
  const url = /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(deploy.out)?.[0];
  if (url) {
    setTomlVar('SUBMIT_URL', url);
    ok(`后端已部署:${url}(已写入 wrangler.toml)`);
  } else {
    warn('部署成功但没解析到地址,请手动把 SUBMIT_URL 写进 wrangler.toml');
    say(deploy.out.trim());
  }
}

async function cmdTables(flags) {
  const token = adminToken(flags);
  const base = submitUrl();
  if (!base) die('先跑 `deploy`(需要知道后端地址)');

  process.stdout.write(c.dim('  调用 /admin/bootstrap 建表…\n'));
  const boot = await adminApi('/admin/bootstrap', { token, method: 'POST', body: {} });
  if (boot.status !== 200) die(`bootstrap 失败:${JSON.stringify(boot.body)}`);
  const { table_id, registry_table_id, request_table_id } = boot.body;
  ok(`主表 ${table_id} / 登记表 ${registry_table_id} / 申请表 ${request_table_id}`);

  setTomlVar('BITABLE_TABLE_ID', table_id);
  setTomlVar('REGISTRY_TABLE_ID', registry_table_id);
  setTomlVar('REQUEST_TABLE_ID', request_table_id);
  ok('table id 已写回 wrangler.toml');

  process.stdout.write(c.dim('  重新部署以让 Worker 读到这些 id…\n'));
  const deploy = wrangler(['deploy']);
  if (deploy.code !== 0) die(`部署失败:${deploy.out.trim()}`);
  ok('已重新部署');

  if (flags['skip-form']) { warn('按要求跳过表单配置'); return; }
  await setupForm(flags);
}

/// 把「密钥申请」表配成:表单只问「申请人」,并开启分享;同时收紧 base 可见范围。
async function setupForm(flags) {
  const { appId, appSecret } = resolvedFeishu(flags);
  if (!appId || !appSecret) { warn('缺飞书凭据,跳过表单配置(可先跑 `feishu`)'); return; }
  const token = await feishuToken(appId, appSecret);
  const baseToken = tomlVar('BITABLE_APP_TOKEN');
  const table = tomlVar('REQUEST_TABLE_ID');
  if (!baseToken || !table) { warn('缺 base/表 id,跳过表单配置'); return; }

  // 1) 找到或创建表单视图
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

  // 2) 只留「申请人」:其余隐藏,且必须"先取消必填再隐藏"
  const fields = (await feishuApi(`/bitable/v1/apps/${baseToken}/tables/${table}/fields?page_size=100`, token)).data?.items ?? [];
  const nameOf = Object.fromEntries(fields.map((f) => [f.field_id, f.field_name]));
  const formPath = `/bitable/v1/apps/${baseToken}/tables/${table}/forms/${form.view_id}`;
  const formFields = (await feishuApi(`${formPath}/fields`, token)).data?.items ?? [];
  const applicantName = '申请人';
  for (const item of formFields) {
    const name = nameOf[item.field_id] ?? '';
    const isApplicant = name === applicantName;
    if (isApplicant) {
      await feishuApi(`${formPath}/fields/${item.field_id}`, token, { method: 'PATCH', body: JSON.stringify({ visible: true, required: true }) });
      continue;
    }
    if (item.visible === false && item.required === false) continue;
    if (item.required) {
      // 隐藏字段不允许直接改 required,先显示出来取消必填,再隐藏
      await feishuApi(`${formPath}/fields/${item.field_id}`, token, { method: 'PATCH', body: JSON.stringify({ visible: true, required: false }) });
    }
    await feishuApi(`${formPath}/fields/${item.field_id}`, token, { method: 'PATCH', body: JSON.stringify({ visible: false }) });
  }
  ok(`表单只保留「${applicantName}」`);

  // 3) 开启表单分享
  const shared = await feishuApi(formPath, token, { method: 'PATCH', body: JSON.stringify({ shared: true }) });
  const url = shared.data?.form?.shared_url;
  if (url) ok(`表单地址:${url}`);
  else warn(`表单分享开启失败:${shared.msg ?? JSON.stringify(shared)}`);

  // 4) 收紧 base:关闭链接分享,把管理员加为协作者(Key 只有管理员能看)
  const closed = await feishuApi(`/drive/v1/permissions/${baseToken}/public?type=bitable`, token, {
    method: 'PATCH', body: JSON.stringify({ link_share_entity: 'closed' }),
  });
  ok(closed.code === 0 ? 'base 链接分享已关闭' : `关闭链接分享失败:${closed.msg}`);

  const adminOpenId = flags['admin-open-id'] || process.env.DIGEST_ADMIN_OPEN_ID;
  if (adminOpenId) {
    const added = await feishuApi(`/drive/v1/permissions/${baseToken}/members?type=bitable&need_notification=false`, token, {
      method: 'POST', body: JSON.stringify({ member_type: 'openid', member_id: adminOpenId, perm: 'full_access' }),
    });
    ok(added.code === 0 ? '管理员已加为 base 协作者' : `添加协作者失败:${added.msg}`);
  } else {
    warn('未提供 --admin-open-id,跳过"把管理员加为协作者"(否则 base 只有应用能看到)');
  }
}

async function fetchEmployees(flags) {
  const { appId, appSecret } = resolvedFeishu(flags);
  if (!appId || !appSecret) die('缺飞书凭据:先跑 `feishu`');
  const token = await feishuToken(appId, appSecret);
  const extra = (flags['scan-bases'] || process.env.DIGEST_SCAN_BASES || tomlVar('SCAN_BASES') || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return listEmployees(token, extra);
}

async function cmdEmployees(flags) {
  const people = await fetchEmployees(flags);
  if (!people.length) die('没找到任何员工(人员字段为空?)');
  say(c.bold(`\n共 ${people.length} 人`));
  for (const p of people) say(`  ${p.name.padEnd(14)} ${p.open_id}   ${c.dim(p.source)}`);
  say('');
}

async function cmdIssue(flags) {
  const token = adminToken(flags);
  let memberId = flags['member-id'];
  let name = flags.name;
  let openId = flags['open-id'];

  if (!openId) {
    const people = await fetchEmployees(flags);
    if (!people.length) die('没找到员工');
    if (flags.yes) die('非交互模式请提供 --open-id');
    say(c.bold('\n选择员工(可多选,如 1,3,5)'));
    people.forEach((p, i) => say(`  ${String(i + 1).padStart(2)}. ${p.name.padEnd(14)} ${c.dim(p.source)}`));
    const answer = await ask('序号');
    const picks = answer.split(/[,，\s]+/).map((s) => Number(s) - 1).filter((i) => people[i]);
    if (!picks.length) die('没有选中任何人');
    for (const i of picks) {
      const person = people[i];
      const mid = await ask(`「${person.name}」的成员ID(工号/账号)`, { defaultValue: person.open_id.slice(-6) });
      const r = await adminApi('/admin/keys', { token, method: 'POST', body: { member_id: mid, member: person.name, open_id: person.open_id } });
      reportIssue(person.name, r);
    }
    return;
  }

  if (!memberId) memberId = await ask('成员ID(工号/账号)', { defaultValue: openId.slice(-6) });
  if (!name) name = await ask('姓名');
  const r = await adminApi('/admin/keys', { token, method: 'POST', body: { member_id: memberId, member: name, open_id: openId } });
  reportIssue(name, r);
}

function reportIssue(label, r) {
  if (r.status !== 201 || !r.body?.key) {
    warn(`「${label}」签发失败:${JSON.stringify(r.body)}`);
    return;
  }
  ok(`「${label}」的 Key(只显示这一次):`);
  say(`    ${c.bold(r.body.key)}`);
  if (r.body.registry) say(c.dim(`    台账:${r.body.registry.join(',')}`));
}

async function cmdKeys(flags) {
  const r = await adminApi('/admin/keys', { token: adminToken(flags) });
  if (r.status !== 200) die(`查询失败:${JSON.stringify(r.body)}`);
  say(c.bold(`\n共 ${r.body.keys.length} 把 Key`));
  for (const k of r.body.keys) {
    const state = k.enabled ? c.green('启用') : c.dim('已撤销');
    say(`  ${k.key_id}  ${String(k.member).padEnd(14)} ${String(k.member_id).padEnd(12)} ${state}  ${c.dim(k.created_at ?? '')}`);
  }
  say('');
}

async function cmdRevoke(flags) {
  const keyId = flags._[0];
  if (!keyId) die('用法:revoke <key_id>');
  const r = await adminApi('/admin/keys/revoke', { token: adminToken(flags), method: 'POST', body: { key_id: keyId } });
  if (r.status !== 200) die(`撤销失败:${JSON.stringify(r.body)}`);
  ok(`已撤销 ${keyId}(${r.body.member ?? ''}),下一次请求立即失效`);
}

async function cmdLogs(flags) {
  const params = new URLSearchParams();
  if (flags.limit) params.set('limit', flags.limit);
  if (flags.member) params.set('member_id', flags.member);
  if (flags.date) params.set('date', flags.date);
  if (flags.event) params.set('event', flags.event);
  if (flags.outcome) params.set('outcome', flags.outcome);
  const r = await adminApi(`/admin/logs?${params}`, { token: adminToken(flags) });
  if (r.status !== 200) die(`查询失败:${JSON.stringify(r.body)}`);
  say(c.bold(`\n共 ${r.body.count} 条`));
  for (const row of r.body.logs) {
    const tag = row.outcome === 'ok' ? c.green('ok  ') : c.red('err ');
    const detail = row.outcome === 'ok'
      ? `mode=${row.mode ?? '-'} items=${row.items ?? '-'}`
      : `err=${row.error_code ?? '-'} ${String(row.error_message ?? '').slice(0, 60)}`;
    say(`  ${row.ts.slice(0, 19).replace('T', ' ')} ${tag} ${String(row.event).padEnd(10)} ${String(row.member_id ?? '-').padEnd(12)} ${detail}`);
  }
  say('');
}

async function cmdInstall(flags) {
  say(c.bold('\n日报上报后端 · 安装向导'));
  say(c.dim('每一步都可以单独重跑;已完成的步骤会自动跳过。\n'));
  await cmdStatus();

  const steps = [
    ['配置飞书应用凭据', () => cmdFeishu(flags)],
    ['配置管理员口令', () => cmdAdminToken(flags)],
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
  if (people.length && (await confirm('现在为员工签发 Key?', { yes: false }))) await cmdIssue(flags);

  await cmdStatus();
  say('完成。下一步:把后端地址 + Key 填进 App 的「设置」面板。\n');
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
  install: cmdInstall,
  status: cmdStatus,
  feishu: cmdFeishu,
  'admin-token': cmdAdminToken,
  deploy: cmdDeploy,
  tables: cmdTables,
  employees: cmdEmployees,
  issue: cmdIssue,
  keys: cmdKeys,
  revoke: cmdRevoke,
  logs: cmdLogs,
};

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'status';
const flags = parseArgs(command === argv[0] ? argv.slice(1) : argv);

if (!COMMANDS[command] || flags.help) {
  say(`日报上报后端管理 CLI

用法:node workers/scripts/digest-admin.mjs <命令> [选项]

命令:
  install          全流程引导(首次使用推荐)
  status           显示当前配置缺什么(默认命令)
  feishu           配置并校验飞书应用凭据(App ID/Secret)
  admin-token      配置管理员口令
  deploy           创建 KV + D1、应用日志表结构、部署 Worker
  tables           建飞书表 → 回填 table id → 重新部署 → 配置表单
  employees        读取员工(含 open_id)
  issue            选员工生成 Key(交互式;或 --open-id/--name/--member-id)
  keys             列出已签发的 Key
  revoke <key_id>  撤销某把 Key
  logs             查询审计日志(--member/--date/--event/--outcome/--limit)

常用选项:
  --yes                  全部确认(非交互)
  --app-id/--app-secret  直接给飞书凭据
  --admin-token          直接给管理员口令
  --admin-open-id        配置表单时把该用户加为 base 协作者
  --scan-bases token:名  额外扫描的 base(员工在别人共享的表里时用)
  --skip-form            只建表,不配置表单
  --local-only           仅用于 admin-token:只存本机钥匙串,不改 Cloudflare 上的口令

环境变量:WRANGLER_CMD(默认 "npx --yes wrangler")、DIGEST_SUBMIT_URL、ADMIN_TOKEN、DIGEST_SCAN_BASES
配置项:wrangler.toml 的 [vars] SUBMIT_URL / SCAN_BASES(员工在共享表里时填 base_token:名称)
`);
  process.exit(flags.help || !COMMANDS[command] ? 1 : 0);
}

try {
  await COMMANDS[command](flags);
} catch (err) {
  die(err.message ?? String(err));
} finally {
  closeReader();
}
