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
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  // out 仅用于展示(错误信息);解析 JSON 必须只用 stdout ——
  // `npx wrangler` 会把 npm notice 写到 stderr,拼进来会让 JSON.parse 报
  // "Unexpected non-whitespace character after JSON"。
  return { code: result.status, stdout, stderr, out: `${stdout}${stderr}` };
}

/// 判断 wrangler 登录状态。必须区分两种失败:
///   · 确实没登录      → 提示去 login
///   · wrangler 没跑起来(npm 缓存权限、网络等)→ 提示真实原因,不能笼统说"未登录"
function wranglerAuthState() {
  const r = wrangler(['whoami']);
  const out = r.out ?? '';
  if (/not logged in|auth token has expired|CLOUDFLARE_API_TOKEN/i.test(out)) return { state: 'logged-out', out };
  if (r.code !== 0 || !/logged in with/i.test(out)) return { state: 'error', out };
  const email = /associated with the email ([^\s]+)/.exec(out)?.[1]?.replace(/\.$/, '');
  return { state: 'logged-in', email, out };
}

/// 未登录时自动拉起 `wrangler login`(会打开浏览器),登录成功后返回。
/// 只在真终端里尝试:非交互环境跑 login 只会挂住。
async function autoLogin() {
  if (!process.stdin.isTTY) {
    fail(`未登录 Cloudflare,且当前不是交互终端,无法自动登录。请先执行:\n    ${WRANGLER} login\n  (或设置 CLOUDFLARE_API_TOKEN)`);
  }
  say(c.yellow('!') + ' 检测到未登录 Cloudflare,正在启动 `' + `${WRANGLER} login` + '`(会打开浏览器)…');
  // stdio 交给子进程:login 要打印授权链接并等待回调
  const [cmd, ...base] = WRANGLER.split(' ').filter(Boolean);
  run(cmd, [...base, 'login'], { capture: false });
  const after = wranglerAuthState();
  if (after.state !== 'logged-in') {
    fail('登录未完成。可稍后重试,或改用环境变量 CLOUDFLARE_API_TOKEN。');
  }
  ok(`已登录 Cloudflare${after.email ? `(${after.email})` : ''}`);
  return after;
}

/// 管理动作的前置条件:必须已登录 Cloudflare。
/// 这正是本设计的安全门槛 —— 没有 wrangler 凭据就动不了后端。
/// 未登录时不再直接退出,而是先尝试自动登录(见 autoLogin)。
async function requireLogin() {
  const state = wranglerAuthState();
  if (state.state === 'logged-in') return state;
  if (state.state === 'error') {
    const first = (state.out ?? '').trim().split('\n').filter((l) => l.trim() && !/WARNING|Proxy environment/.test(l))[0] ?? '';
    fail(`wrangler 执行失败(不是登录问题):\n    ${first}\n  可执行 \`${WRANGLER} whoami\` 复查;常见原因是 npm 缓存目录权限(npm error code EPERM)。`);
  }
  return autoLogin();
}

/// 启动时自动补登录;失败只提示,不阻断(有些功能不需要 Cloudflare)。
async function tryAutoLogin() {
  const state = wranglerAuthState();
  if (state.state === 'logged-in') return state;
  if (state.state === 'error') {
    warn('wrangler 执行失败(不是登录问题),请先修好再使用管理功能');
    return null;
  }
  try {
    return await autoLogin();
  } catch (err) {
    warn(err instanceof CliError ? err.message : String(err.message ?? err));
    return null;
  }
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

/// 终端里的显示宽度:中日韩文字与全角符号占 2 列。
/// 直接用 padEnd 会按"字符数"补齐,导致中英文混排时列歪掉。
function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    const wide = (cp >= 0x1100 && cp <= 0x115f)
      || (cp >= 0x2e80 && cp <= 0xa4cf)
      || (cp >= 0xac00 && cp <= 0xd7a3)
      || (cp >= 0xf900 && cp <= 0xfaff)
      || (cp >= 0xfe30 && cp <= 0xfe6f)
      || (cp >= 0xff00 && cp <= 0xff60)
      || (cp >= 0xffe0 && cp <= 0xffe6)
      || (cp >= 0x20000 && cp <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}

function padEndWidth(text, width) {
  const s = String(text);
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)));
}

/* -------------------------------------------------------------- 进度动画 */

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

let spinnerActive = false;

/// 执行耗时操作时显示旋转动画(仅真终端)。非终端只打印一行,避免污染输出。
/// 嵌套调用不再起第二个动画 —— 两个定时器抢同一行会互相覆盖成花屏。
async function withSpinner(label, fn) {
  if (spinnerActive) return fn();
  spinnerActive = true;
  const tty = Boolean(process.stdout.isTTY);
  let index = 0;
  let timer = null;
  const draw = () => process.stdout.write(`\r\x1b[2m${SPINNER_FRAMES[index++ % SPINNER_FRAMES.length]} ${label}\x1b[0m`);
  const clear = () => { if (tty) process.stdout.write('\r\x1b[0J'); };
  if (tty) { draw(); timer = setInterval(draw, 80); } else { say(c.dim(`  ${label}…`)); }
  try {
    const result = await fn();
    if (timer) clearInterval(timer);
    clear();
    return result;
  } catch (err) {
    if (timer) clearInterval(timer);
    clear();
    throw err;
  } finally {
    spinnerActive = false;
  }
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

/// 读取密钥类输入:终端下不回显(打 * 号),管道下按普通行读。
async function askSecret(question) {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return (await ask(question)).trim();
  closeReader();
  if (stdin.isPaused()) stdin.resume();
  process.stdout.write(`${c.bold('?')} ${question}: `);
  return new Promise((resolve) => {
    let buffer = '';
    const finish = (value) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stdout.write('\n');
      resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') return finish(buffer.trim());
        if (ch === '\u0003') { finish(''); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') { buffer = buffer.slice(0, -1); process.stdout.write('\b \b'); continue; }
        buffer += ch;
        process.stdout.write('*');
      }
    };
    stdin.setRawMode(true);
    stdin.on('data', onData);
  });
}

/// 取飞书 App Secret:参数 → 环境变量 → 钥匙串 → 现场输入(只用于本次,不落盘)。
async function ensureFeishuSecret(flags) {
  const { appSecret } = resolvedFeishu(flags);
  if (appSecret) return appSecret;
  const entered = await askSecret('飞书 App Secret(仅本次使用,不保存)');
  if (!entered) fail('缺少飞书 App Secret');
  return entered;
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
            if (!person?.id) continue;
            const source = `${base.name}/${table.name}`;
            const entry = people.get(person.id) ?? { name: person.name ?? '(无名)', sources: [] };
            if (!entry.sources.includes(source)) entry.sources.push(source);
            people.set(person.id, entry);
          }
        }
      }
    }
  }
  return [...people]
    .map(([open_id, v]) => ({ open_id, name: v.name, sources: v.sources }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

async function fetchEmployees(flags) {
  const { appId } = resolvedFeishu(flags);
  if (!appId) fail('缺飞书 App ID:先跑 `feishu`');
  const appSecret = await ensureFeishuSecret(flags);
  const token = await withSpinner('读取飞书通讯录', () => feishuToken(appId, appSecret));
  const extra = (flags['scan-bases'] || process.env.DIGEST_SCAN_BASES || tomlVar('SCAN_BASES') || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return listEmployees(token, extra);
}

/* ------------------------------------------------------------------ 命令 */

async function cmdStatus() {
  const feishu = resolvedFeishu({});
  const auth = wranglerAuthState();
  const loginCell = {
    'logged-in': c.green(`已登录${auth.email ? `(${auth.email})` : ''}`),
    'logged-out': c.red('未登录(需要 wrangler login)'),
    error: c.red('wrangler 执行失败(非登录问题,详情见 whoami 输出)'),
  }[auth.state];
  const rows = [
    ['Cloudflare 登录', loginCell],
    ['飞书 App ID', tomlVar('FEISHU_APP_ID') ? c.green('已配置') : c.red('缺失')],
    ['飞书 App Secret', feishu.appSecret ? c.green('已配置(钥匙串/环境变量)') : c.red('缺失')],
    ['KV 命名空间', hasBinding('kv_namespaces') ? c.green('已绑定') : c.red('缺失')],
    ['D1 数据库', hasBinding('d1_databases') ? c.green('已绑定') : c.red('缺失')],
    ['主表 ID', tomlVar('BITABLE_TABLE_ID') || c.red('缺失')],
    ['定时任务', /crons\s*=/.test(readToml()) ? c.green('每小时清理日志') : c.red('未配置')],
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
  await requireLogin();
  let appId = flags['app-id'] || tomlVar('FEISHU_APP_ID') || keychainGet('feishu-app-id')?.value || '';
  let appSecret = flags['app-secret'] || keychainGet('feishu-app-secret')?.value || '';

  // 已配置的值作为默认值直接显示,回车即沿用
  if (!appId) appId = (await ask('飞书 App ID (cli_…)')).trim();
  if (!appId.startsWith('cli_')) fail(`App ID 看起来不对:${appId}(应以 cli_ 开头)`);
  const hadSecret = Boolean(appSecret);
  if (!appSecret) {
    appSecret = await askSecret('飞书 App Secret(输入不回显)');
    if (!appSecret) fail('缺少 App Secret');
  }

  await withSpinner('校验飞书凭据', () => feishuToken(appId, appSecret));
  ok(`飞书凭据有效(App ID ${appId.slice(0, 12)}…)`);

  if (tomlVar('FEISHU_APP_ID') !== appId) {
    setTomlVar('FEISHU_APP_ID', appId);
    ok(`已写入 wrangler.toml 的 FEISHU_APP_ID(${appId})`);
  } else {
    ok(`FEISHU_APP_ID 未变(${appId}),无需改写`);
  }
  if (hadSecret && flags['keep-secret']) {
    ok('沿用已有的 FEISHU_APP_SECRET,未改写 Cloudflare secret');
    return;
  }
  const r = await withSpinner('写入 Worker secret FEISHU_APP_SECRET', () => wrangler(['secret', 'put', 'FEISHU_APP_SECRET'], { input: appSecret }));
  if (r.code !== 0) fail(`写入 secret 失败:${r.out.trim()}`);
  ok('FEISHU_APP_SECRET 已写入 Cloudflare');
  say(c.dim('  提示:本 CLI 不保存密钥;如需免输入,可自行执行'));
  say(c.dim(`    security add-generic-password -s ${KEYCHAIN_SERVICE} -a feishu-app-secret -w`));
}

async function cmdDeploy(flags) {
  await requireLogin();
  if (!hasBinding('kv_namespaces')) {
    const r = await withSpinner('创建 KV 命名空间 KEYS', () => wrangler(['kv', 'namespace', 'create', 'KEYS']));
    const id = /id\s*=\s*"([0-9a-f]{32})"/.exec(r.out ?? '')?.[1];
    if (!id) fail(`创建 KV 失败:${(r.out ?? '').trim()}`);
    appendBinding(`# API Key 存放在 KV:签发时绑定人员,撤销即时生效。\n[[kv_namespaces]]\nbinding = "KEYS"\nid = "${id}"`);
    ok(`KV 已创建并写入 wrangler.toml(${id})`);
  } else ok('KV 已绑定,跳过');

  if (!hasBinding('d1_databases')) {
    const r = await withSpinner('创建 D1 数据库', () => wrangler(['d1', 'create', D1_NAME]));
    const id = /database_id\s*=\s*"([0-9a-f-]{36})"/.exec(r.out ?? '')?.[1];
    if (!id) fail(`创建 D1 失败:${(r.out ?? '').trim()}`);
    appendBinding(`# 审计日志(提交/签发/撤销)持久化在 D1。\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "${D1_NAME}"\ndatabase_id = "${id}"`);
    ok(`D1 已创建并写入 wrangler.toml(${id})`);
  } else ok('D1 已绑定,跳过');

  const schema = await withSpinner('应用 schema.sql(建 audit_log 表)', () => wrangler(['d1', 'execute', D1_NAME, '--remote', '--file=schema.sql']));
  if (schema.code !== 0) fail(`建表失败:${(schema.out ?? '').trim()}`);
  ok('audit_log 表已就绪');

  const deploy = await withSpinner('部署 Worker', () => wrangler(['deploy']));
  if (deploy.code !== 0) fail(`部署失败:${(deploy.out ?? '').trim()}`);
  const url = /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(deploy.out ?? '')?.[0];
  if (url) { setTomlVar('SUBMIT_URL', url); ok(`后端已部署:${url}`); }
  else warn('部署成功但没解析到地址,请手动把 SUBMIT_URL 写进 wrangler.toml');
}

async function cmdTables(flags) {
  await requireLogin();
  const env = buildEnv(flags, { withKv: true, withDb: true });
  const result = await withSpinner('直连飞书建表 / 建字段', () => bootstrapLocally(env));
  ok(`主表 ${result.tableId}`);
  if (result.created.length) say(c.dim(`    新建:${result.created.join(', ')}`));

  if (tomlVar('BITABLE_TABLE_ID') !== result.tableId) {
    setTomlVar('BITABLE_TABLE_ID', result.tableId);
    ok(`已写回 wrangler.toml(BITABLE_TABLE_ID=${result.tableId})`);
  } else {
    ok(`BITABLE_TABLE_ID 未变(${result.tableId}),无需改写`);
  }

  const deploy = await withSpinner('重新部署以让 Worker 读到表 id', () => wrangler(['deploy']));
  if (deploy.code !== 0) fail(`部署失败:${(deploy.out ?? '').trim()}`);
  ok('已重新部署');
}

async function cmdEmployees(flags) {
  const people = await fetchEmployees(flags);
  if (!people.length) fail('没找到任何员工(人员字段为空?)');
  say(c.bold(`\n共 ${people.length} 人`));
  say(c.dim(`  ${padEndWidth('姓名', 16)}${padEndWidth('open_id', 38)}读到的位置`));
  for (const p of people) {
    const where = p.sources.length > 1 ? `${p.sources[0]} 等${p.sources.length}处` : p.sources[0];
    say(`  ${padEndWidth(p.name, 16)}${p.open_id}   ${c.dim(where)}`);
  }
  say(c.dim('  第三列是"这份 open_id 从哪张表读到的":飞书不允许跨应用使用 open_id,'));
  say(c.dim('  所以只能从企业已有表格的人员字段里取,标出来源便于核对。'));
  say('');
}

async function cmdIssue(flags) {
  await requireLogin();
  const env = buildEnv(flags);

  if (flags['open-id']) {
    const memberId = flags['member-id'] || await ask('成员ID(工号/账号)', { defaultValue: String(flags['open-id']).slice(-6) });
    const name = flags.name || await ask('姓名');
    return reportIssue(name, await withSpinner(`为「${name}」签发 Key`, () => issueLocally(env, { member_id: memberId, member: name, open_id: flags['open-id'] })));
  }
  if (flags.email) {
    const name = flags.name || await ask('姓名');
    const memberId = flags['member-id'] || await ask('成员ID(工号/账号)');
    return reportIssue(name, await withSpinner(`为「${name}」签发 Key`, () => issueLocally(env, { member_id: memberId, member: name, email: flags.email })));
  }

  const people = await fetchEmployees(flags);
  if (!people.length) fail('没找到员工');
  say(c.bold('\n选择员工(可多选,如 1,3,5)'));
  people.forEach((p, i) => {
    const where = p.sources.length > 1 ? `${p.sources[0]} 等${p.sources.length}处` : p.sources[0];
    say(`  ${String(i + 1).padStart(2)}. ${padEndWidth(p.name, 16)}${c.dim(where)}`);
  });
  const picks = (await ask('序号')).split(/[,，\s]+/).map((s) => Number(s) - 1).filter((i) => people[i]);
  if (!picks.length) fail('没有选中任何人');
  for (const i of picks) {
    const person = people[i];
    const mid = await ask(`「${person.name}」的成员ID(工号/账号)`, { defaultValue: person.open_id.slice(-6) });
    reportIssue(person.name, await withSpinner(`为「${person.name}」签发 Key`, () => issueLocally(env, { member_id: mid, member: person.name, open_id: person.open_id })));
  }
}

function reportIssue(label, issued) {
  ok(`「${label}」的 Key(只显示这一次):`);
  say(`    ${c.bold(issued.key)}`);
  say(c.dim('    请立即发给本人;列表里只会显示掩码。丢失请在「员工与 Key」里轮换。'));
  if (issued.superseded?.length) say(c.dim(`    已作废旧 Key:${issued.superseded.join(', ')}(一人一把)`));
}

async function cmdKeys(flags) {
  await requireLogin();
  const keys = await listKeysLocally(buildEnv(flags, { withDb: false }));
  say(c.bold(`\n共 ${keys.length} 把 Key`));
  say(c.dim(`  ${padEndWidth('成员', 16)}状态    Key(掩码)`));
  for (const k of keys) {
    const state = k.enabled ? c.green('启用') : c.dim('已撤销');
    say(`  ${padEndWidth(k.member, 16)}${state}  ${c.dim(k.masked ?? '(无掩码)')}`);
  }
  say('');
}

async function cmdRevoke(flags) {
  await requireLogin();
  const keyId = flags._[0];
  if (!keyId) fail('用法:revoke <key_id>');
  // 撤销是写操作,必须带 DB —— 漏了它这次撤销就不会进审计日志(踩过)
  const env = buildEnv(flags);
  const revoked = await withSpinner(`撤销 ${keyId}`, () => revokeLocally(env, keyId));
  ok(`已撤销 ${revoked.key_id}(${revoked.member ?? ''}),下一次请求立即失效`);
}

async function cmdLogs(flags) {
  await requireLogin();
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
  say(c.dim('管理动作全部在本机执行,需要先登录 Cloudflare;已配置的步骤会显示当前值并默认跳过。\n'));
  await requireLogin(); // 未登录会自动拉起 wrangler login

  // 每一步的"当前配置"摘要:已配置的直接展示出来,作为是否重做的判断依据
  const summaries = {
    feishu: () => {
      const id = tomlVar('FEISHU_APP_ID');
      const secret = resolvedFeishu({}).appSecret;
      if (!id || !secret) return null;
      return `App ID ${id};App Secret ${c.dim('已配置(钥匙串/环境变量)')}`;
    },
    deploy: () => {
      const kv = kvNamespaceId();
      const d1 = d1DatabaseName();
      const url = tomlVar('SUBMIT_URL');
      if (!kv || !d1) return null;
      return `KV ${kv.slice(0, 8)}…;D1 ${d1}${url ? `;地址 ${url}` : ''}`;
    },
    tables: () => {
      const main = tomlVar('BITABLE_TABLE_ID');
      return main ? `主表 ${main}` : null;
    },
  };

  const steps = [
    ['配置飞书应用凭据', 'feishu', (f) => cmdFeishu(f)],
    ['创建 KV/D1 并部署后端', 'deploy', (f) => cmdDeploy(f)],
    ['建飞书表并回填 table id', 'tables', (f) => cmdTables(f)],
  ];
  for (const [label, key, fn] of steps) {
    const current = summaries[key]();
    if (current) {
      say(`\n▶ ${label} —— ${c.green('已配置')}`);
      say(c.dim(`    当前值:${current}`));
      if (!await confirm('已配置,是否重新执行?', { yes: false })) { warn(`保留现有配置,跳过「${label}」`); continue; }
    } else {
      say(`\n▶ ${label} —— ${c.yellow('未配置')}`);
      if (!await confirm('现在执行?', { yes: flags.yes })) { warn(`跳过「${label}」`); continue; }
    }
    await fn(flags);
  }

  await cmdStatus();
  say(c.bold('\n▶ 员工与 Key'));
  const people = await fetchEmployees(flags);
  say(`  员工名单:${people.length} 人`);
  if (people.length && await confirm('现在管理员工与 Key(签发 / 轮换 / 撤销)?', { yes: false })) {
    await cmdMembers(flags);
  }
  say('\n完成。下一步:把后端地址 + Key 填进 App 的「设置」面板。\n');
}

/* ---------------------------------------------------------- 方向键选择器 */

/// 上下箭头选择(仅真终端):返回被选中的条目,取消返回 null。
/// 管道/重定向等非终端场景返回 null,由调用方退回"输入编号"的方式,保证脚本可用。
function selectMenu(entries, { footer = '↑/↓ 移动 · Enter 确认 · q 退出' } = {}) {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return Promise.resolve(null);

  // readline 与 raw mode 不能同时读 stdin,先把 readline 收起来
  closeReader();
  if (stdin.isPaused()) stdin.resume();

  let cursor = entries.findIndex((e) => !e.header);
  let printedLines = 0;
  const render = () => {
    const buf = [];
    if (printedLines) buf.push(`\x1b[${printedLines}A`); // 回到菜单顶部
    buf.push('\x1b[0J'); // 清掉旧内容
    let lines = 0;
    for (const [i, e] of entries.entries()) {
      if (e.header) {
        buf.push(`  \x1b[2m── ${e.header} ──\x1b[0m\n`);
      } else {
        const row = `  ${i === cursor ? '❯' : ' '} ${e.label}`;
        buf.push(i === cursor ? `\x1b[7m${row}\x1b[0m\n` : `${row}\n`);
      }
      lines += 1;
    }
    buf.push(`\x1b[2m  ${footer}\x1b[0m\n`);
    lines += 1;
    stdout.write(buf.join(''));
    printedLines = lines;
  };
  render();

  return new Promise((resolve) => {
    const finish = (value) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stdout.write('\n');
      resolve(value);
    };
    const move = (delta) => {
      let next = cursor;
      do { next = (next + delta + entries.length) % entries.length; } while (entries[next].header);
      cursor = next;
      render();
    };
    const onData = (chunk) => {
      const key = chunk.toString('utf8');
      if (key === '\u001b[A' || key === '\u001bOA') return move(-1);
      if (key === '\u001b[B' || key === '\u001bOB') return move(1);
      if (key === '\r' || key === '\n') return finish(entries[cursor]);
      if (key === 'q' || key === '\u0003' || key === '\u001b') return finish(null);
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

/// 有真终端就用方向键;否则让用户输编号。返回 null 表示取消/退出。
async function choose(entries, { prompt = '请选择', footer } = {}) {
  const picked = await selectMenu(entries, footer ? { footer } : {});
  if (picked !== null) return picked;
  if (process.stdin.isTTY) return null; // 真终端里取消了
  // 非终端:退回编号输入,方便脚本与自动化
  const selectable = entries.filter((e) => !e.header);
  selectable.forEach((e, i) => say(`  ${String(i + 1).padStart(3)}) ${e.label}`));
  const answer = (await ask(`${prompt}编号(回车退出)`)).trim().toLowerCase();
  if (!answer || ['0', 'q', 'quit', 'exit'].includes(answer)) return null;
  const index = Number(answer) - 1;
  if (!selectable[index]) { warn(`没有编号 ${answer}`); return null; }
  return selectable[index];
}

/* ---------------------------------------------------------------- 管理台 */

/// 员工与 Key 合并视图:一个入口完成 列出 / 签发 / 轮换 / 撤销。
///
///   · 没有 Key 的员工:只显示名字,选中后问"是否签发";
///   · 已有 Key 的员工:显示 key_id 与状态,选中后问"轮换 / 撤销 / 取消"。
async function cmdMembers(flags) {
  await requireLogin();
  const env = buildEnv(flags);
  const [people, keys] = await withSpinner('读取员工与 Key', () => Promise.all([fetchEmployees(flags), listKeysLocally(env)]));
  const activeByOpenId = new Map(keys.filter((k) => k.enabled).map((k) => [k.open_id, k]));

  const rows = [];
  for (const person of people) {
    const key = activeByOpenId.get(person.open_id);
    if (key) activeByOpenId.delete(person.open_id); // 已配对,剩下的就是"库里有 Key 但名单里没有"的
    rows.push({
      kind: 'person',
      person,
      key,
      label: key
        ? `${padEndWidth(person.name, 16)}${c.green('已签发')}  ${c.dim(key.masked ?? key.key_id)}`
        : `${padEndWidth(person.name, 16)}${c.dim('未签发')}`,
    });
  }
  // 名单抓不到、但 KV 里有 Key 的人(例如换了表格或已离职)
  for (const key of activeByOpenId.values()) {
    rows.push({
      kind: 'orphan',
      key,
      label: `${padEndWidth(key.member, 16)}${c.yellow('有 Key 但不在员工名单')}  ${c.dim(key.masked ?? key.key_id)}`,
    });
  }
  if (!rows.length) return warn('没有可管理的人(员工名单为空且没有已签发的 Key)');

  const entries = [
    { header: `员工与 Key(共 ${rows.length} 人)` },
    ...rows.map((row) => ({ ...row, label: row.label })),
  ];
  const picked = await choose(entries, {
    prompt: '选择员工',
    footer: '↑/↓ 移动 · Enter 选择 · q 返回',
  });
  if (!picked) { warn('已取消'); return; }

  if (picked.kind === 'orphan') {
    if (!await confirm(`「${picked.key.member}」不在员工名单里,撤销其 Key ${picked.key.key_id}?`)) return warn('已取消');
    const revoked = await withSpinner(`撤销 ${picked.key.key_id}`, () => revokeLocally(env, picked.key.key_id));
    return ok(`已撤销 ${revoked.key_id}(${revoked.member ?? ''})`);
  }

  const { person, key } = picked;
  if (!key) {
    if (!await confirm(`为「${person.name}」签发 Key?`)) return warn('已取消');
    const memberId = await ask('成员ID(工号/账号)', { defaultValue: person.open_id.slice(-6) });
    const issued = await withSpinner(`为「${person.name}」签发 Key`, () => issueLocally(env, { member_id: memberId, member: person.name, open_id: person.open_id }));
    return reportIssue(person.name, issued);
  }

  const action = await choose([
    { label: '查看 Key(仅掩码,完整值无法还原)', value: 'show' },
    { label: '轮换:签发新 Key,旧的立即失效', value: 'rotate' },
    { label: '撤销:停用,该成员将无法提交', value: 'revoke' },
    { label: '取消', value: 'cancel' },
  ], { prompt: `「${person.name}」已有 Key`, footer: '↑/↓ 移动 · Enter 确认 · q 取消' });

  if (!action || action.value === 'cancel') return warn('已取消');

  if (action.value === 'show') {
    say(`  ${padEndWidth(person.name, 16)}${c.dim(key.masked ?? key.key_id)}`);
    say(c.dim('    完整 Key 只在签发时显示过一次;成员弄丢就选「轮换」重新签发。'));
    return;
  }

  if (action.value === 'revoke') {
    const revoked = await withSpinner(`撤销 ${key.key_id}`, () => revokeLocally(env, key.key_id));
    return ok(`已撤销 ${revoked.key_id}(${revoked.member ?? ''}),下一次请求立即失效`);
  }

  const issued = await issueLocally(env, {
    member_id: key.member_id || person.open_id.slice(-6),
    member: person.name,
    open_id: person.open_id,
  });
  reportIssue(person.name, issued);
}

/// 管理条目:分组 + 标题,交给方向键选择器渲染。
const MENU_SECTIONS = [
  ['初次安装', [
    ['一键全流程(校验凭据 → 部署 → 建表 → 员工与 Key)', (f) => cmdInstall(f)],
  ]],
  ['配置与部署', [
    ['查看状态(配置 / Cloudflare 登录 / 后端健康)', (f) => cmdStatus(f)],
    ['配置飞书应用凭据(App ID / Secret)', (f) => cmdFeishu(f)],
    ['创建 KV / D1 并部署 Worker', (f) => cmdDeploy(f)],
    ['建飞书表并回填 table id(含配置申请表单)', (f) => cmdTables(f)],
  ]],
  ['成员与 Key', [
    ['员工与 Key(列出 / 签发 / 轮换 / 撤销)', (f) => cmdMembers(f)],
  ]],
  ['审计日志', [
    ['查看最近日志', (f) => cmdLogs({ ...f, limit: 20 })],
    ['按条件查日志(成员 / 日期 / 成功失败)', (f) => cmdLogsMenu(f)],
  ]],
];

async function cmdMenu(flags) {
  await tryAutoLogin(); // 启动即检查:未登录就自动拉起登录,成功后继续
  const items = [];
  for (const [section, entries] of MENU_SECTIONS) {
    items.push({ header: section });
    for (const [label, run] of entries) items.push({ label, run });
  }

  say(c.bold('\n日报上报后端 · 管理台'));
  say(c.dim('  管理动作在本机执行(直连 KV / D1 / 飞书),需要已登录 Cloudflare;Worker 上没有任何管理接口。'));
  for (;;) {
    say('');
    const picked = await choose(items, { prompt: '请选择功能', footer: '↑/↓ 移动 · Enter 确认 · q 退出' });
    if (!picked) { say('已退出。'); return; }
    say('');
    try {
      await picked.run(flags);
    } catch (err) {
      // 单个操作失败(含未登录、缺配置)只提示,不退出管理台
      warn(err instanceof CliError ? err.message : `执行出错:${err.message ?? err}`);
    }
  }
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
  members: cmdMembers,
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
  menu             管理台:↑/↓ 选择功能,Enter 确认(交互终端下的默认命令)
  install          全流程引导(非交互等价于 menu 的一次性版本)
  status           显示配置与 Cloudflare 登录状态
  feishu           配置并校验飞书应用凭据(App ID/Secret)
  deploy           创建 KV + D1、应用日志表结构、部署 Worker
  tables           建飞书表 → 回填 table id → 重新部署 → 配置表单
  members          员工与 Key 合并视图(列出 / 签发 / 轮换 / 撤销)
  employees        只列出员工(含 open_id 与来源)
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
  --keep-secret          飞书凭据已存在时只校验,不改写 Cloudflare secret

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
