#!/usr/bin/env node
// 日报上报后端 · 管理 CLI
//
// 安全模型(重要):
//   · Worker 只暴露成员接口(/healthz、/api/v1/me、/api/v1/digests);
//   · 所有管理动作(建表、发 Key、撤销、查日志)都在**本机**完成,直连 KV / D1 / 飞书;
//   · 门槛:一台已登录 Cloudflare(wrangler)的机器 + 本机飞书 App Secret;
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

import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  bootstrapLocally, d1Adapter, issueLocally, kvAdapter,
  listKeysLocally, logsLocally, revokeLocally,
} from './local-admin.mjs';
import { isPlaceholder, issueReportLines, knownSubmitUrl, parseDeployedUrl, placeholderLabels, resolveSubmitUrl } from './issue-report.mjs';
import {
  activeVersionId, bindingsFromVersion, d1DatabaseNames, kvNamespaceTitles, parseBitableInput, parseWhoamiAccounts,
  pickD1DatabaseId, pickKvNamespaceId,
} from './recover.mjs';
import { listTables, resolveWikiNode } from '../src/feishu.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOML_PATH = path.join(ROOT, 'wrangler.toml');
/// 仓库里跟踪的只有模板;真实配置写在被 .gitignore 忽略的 wrangler.toml 里,
/// 所以 `git status` 始终干净,也不会把真实 token / 子域提交进公开仓库。
const TOML_EXAMPLE_PATH = path.join(ROOT, 'wrangler.toml.example');
/// 实际调用 wrangler 的方式。
///
/// 默认的 `npx --yes wrangler` **每次**都要向 npm registry 解析版本(必要时下载约 30MB),
/// 而 npm 的 fetch-timeout 默认 5 分钟、重试 2 次:网络一慢(或镜像不可达),整个 CLI
/// 就卡在第一个命令上十几分钟 —— 这正是"检查 Cloudflare 登录"卡住的原因。
///
/// 所以优先用**本机已经存在**的 wrangler,一个字节的网络流量都不需要:
///   1. WRANGLER_CMD 显式指定(仍支持 "npx --yes wrangler" 这种带参数写法)
///   2. 仓库里 npm install 出来的 node_modules/.bin/wrangler
///   3. npx 缓存里已有的 wrangler(直接用 node 跑它的 cli.js)
///   4. 实在没有才退回 npx(需要网络,受超时保护)
const WRANGLER_SPEC = (() => {
  const spec = process.env.WRANGLER_CMD || localWranglerBin() || npxCachedWrangler() || 'npx --yes wrangler';
  // WRANGLER_CMD 允许 "npx --yes wrangler" 这种带参数的写法;自动探测到的是单个路径,
  // 但用户主目录可能含空格,所以统一按"命令 + 参数"存,不再用字符串拼接后 split。
  const [cmd, ...base] = spec.split(' ').filter(Boolean);
  return { cmd, base, display: spec };
})();
/// 仅用于展示与提示信息。
const WRANGLER = WRANGLER_SPEC.display;

/// 仓库里 npm install 出来的 wrangler(存在就用它,完全不需要网络)。
function localWranglerBin() {
  const localBin = path.join(ROOT, 'node_modules', '.bin', 'wrangler');
  return existsSync(localBin) ? localBin : null;
}

/// 在 npx 缓存(~/.npm/_npx/*/node_modules/wrangler)里找一个可用的 wrangler。
/// npx 缓存命中时不会联网,但 `npx` 自己仍可能先去 registry 问版本;直接跑 cli.js 更稳。
function npxCachedWrangler() {
  const roots = [];
  const npmCache = process.env.npm_config_cache || path.join(os.homedir(), '.npm');
  roots.push(path.join(npmCache, '_npx'));
  for (const root of roots) {
    let entries = [];
    try { entries = readdirSync(root); } catch { continue; }
    // 缓存里可能有多份(不同解析结果),取最新的那份
    const candidates = [];
    for (const entry of entries) {
      const cli = path.join(root, entry, 'node_modules', 'wrangler', 'wrangler-dist', 'cli.js');
      if (!existsSync(cli)) continue;
      let mtime = 0;
      try { mtime = statSync(cli).mtimeMs; } catch { /* 用 0 兜底 */ }
      candidates.push({ cli, mtime });
    }
    if (candidates.length) {
      candidates.sort((a, b) => b.mtime - a.mtime);
      return `node ${candidates[0].cli}`;
    }
  }
  return null;
}
const KEYCHAIN_SERVICE = 'daily-agent-digest';
// 凭据统一存在这个服务名下(用 `digest-admin.mjs feishu` 写入)
const FEISHU_SERVICES = [KEYCHAIN_SERVICE];
const D1_NAME = 'daily-agent-digest-logs';

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};
// 有动画在跑时:先清掉动画那一行,打印内容,再把动画画回来,避免输出和动画互相覆盖
const say = (...a) => {
  const active = spinnerCtl && process.stdout.isTTY;
  if (active) process.stdout.write('\r\x1b[0J');
  console.log(...a);
  if (active) spinnerCtl.draw();
};
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

/// 异步执行并收集输出。
/// **必须异步**:同步 spawn 会把事件循环整个卡住,旋转动画一帧都发不出来(卡顿根因)。
/// 任何外部命令都必须有超时。
///
/// 之前没有:而 `npx --yes wrangler` 每次都要向 npm registry 解析版本(必要时下载 ~30MB),
/// npm 默认 fetch-timeout 5 分钟、重试 2 次 —— 网络一慢,UI 就永远停在"检查 Cloudflare 登录"。
/// 默认 60 秒,可用 DIGEST_WRANGLER_TIMEOUT=<秒> 放宽(慢网络/npx 首次下载)。
function externalTimeoutMs() {
  const seconds = Number(process.env.DIGEST_WRANGLER_TIMEOUT ?? 60);
  return (Number.isFinite(seconds) && seconds >= 5 ? seconds : 60) * 1000;
}

function runAsync(command, args = [], { input, timeoutMs = externalTimeoutMs() } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => {
      const note = `\n[超过 ${Math.round(timeoutMs / 1000)} 秒没有响应,已终止:${command}]`;
      try { child.kill('SIGKILL'); } catch { /* 已经退出 */ }
      finish({ code: -1, timedOut: true, stdout, stderr: stderr + note, out: stdout + stderr + note });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => finish({ code: -1, stdout, stderr: stderr + err.message, out: stdout + stderr + err.message }));
    child.on('close', (code) => finish({ code, stdout, stderr, out: stdout + stderr }));
    child.stdin.end(input ?? '');
  });
}

async function wrangler(args, { input } = {}) {
  const { cmd, base } = WRANGLER_SPEC;
  // out 仅用于展示(错误信息);解析 JSON 必须只用 stdout ——
  // `npx wrangler` 会把 npm notice 写到 stderr,拼进来会让 JSON.parse 报
  // "Unexpected non-whitespace character after JSON"。
  return runAsync(cmd, [...base, ...args], { input });
}

/// 判断 wrangler 登录状态。必须区分两种失败:
///   · 确实没登录      → 提示去 login
///   · wrangler 没跑起来(npm 缓存权限、网络等)→ 提示真实原因,不能笼统说"未登录"
async function wranglerAuthState() {
  const r = await withSpinner('检查 Cloudflare 登录', () => wrangler(['whoami']));
  const out = r.out ?? '';
  // 超时单独成一类:这不是"没登录",乱提示只会把人带偏
  if (r.timedOut) return { state: 'timeout', out };
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
  run(WRANGLER_SPEC.cmd, [...WRANGLER_SPEC.base, 'login'], { capture: false });
  const after = await wranglerAuthState();
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
  const state = await wranglerAuthState();
  if (state.state === 'logged-in') return state;
  if (state.state === 'timeout') {
    // 以前的默认命令是 `npx --yes wrangler`:每次都要去 npm registry 解析版本(必要时下载 ~30MB),
    // 而 npm 的 fetch-timeout 默认 5 分钟、重试 2 次 —— 网络一慢就表现为"检查 Cloudflare 登录"卡死。
    fail([
      `wrangler 在 ${Math.round(externalTimeoutMs() / 1000)} 秒内没有响应,已终止。`,
      `    当前用的是:${WRANGLER}`,
      `    可先手动跑一次看它慢在哪:${WRANGLER} whoami`,
      '    常见原因:① 正在下载 wrangler(npx 首次,或 npm registry 不可达);',
      '              ② 代理/网络不通(本机设了 http_proxy/https_proxy,或 npm 的 registry 是镜像);',
      '              ③ Cloudflare API 无响应。',
      '    临时放宽超时:DIGEST_WRANGLER_TIMEOUT=180 node workers/scripts/digest-admin.mjs adopt',
      '    指定本机已有的 wrangler(零网络):WRANGLER_CMD=$(command -v wrangler) node workers/scripts/digest-admin.mjs adopt',
    ].join('\n  '));
  }
  if (state.state === 'error') {
    const first = (state.out ?? '').trim().split('\n').filter((l) => l.trim() && !/WARNING|Proxy environment/.test(l))[0] ?? '';
    fail(`wrangler 执行失败(不是登录问题):\n    ${first}\n  可执行 \`${WRANGLER} whoami\` 复查;常见原因是 npm 缓存目录权限(npm error code EPERM)。`);
  }
  return autoLogin();
}

/// 启动时自动补登录;失败只提示,不阻断(有些功能不需要 Cloudflare)。
async function tryAutoLogin() {
  const state = await wranglerAuthState();
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

/// 本地配置不存在时从模板创建一份(新机器 / 重新 clone 后的第一步)。
function ensureLocalConfig() {
  if (existsSync(TOML_PATH) || !existsSync(TOML_EXAMPLE_PATH)) return false;
  copyFileSync(TOML_EXAMPLE_PATH, TOML_PATH);
  warn('已从 wrangler.toml.example 创建本地配置 workers/wrangler.toml');
  say(c.dim('    该文件不会被 git 跟踪;deploy / tables / adopt 会把真实值写进去。'));
  return true;
}

function readToml() {
  ensureLocalConfig();
  return existsSync(TOML_PATH) ? readFileSync(TOML_PATH, 'utf8') : '';
}

/// 本地配置是否被 git 跟踪:跟踪了就说明真实值有被提交的风险,必须提醒。
function localConfigTracked() {
  const r = spawnSync('git', ['ls-files', '--error-unmatch', 'wrangler.toml'], { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0;
}

function tomlVar(name) {
  const m = new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, 'm').exec(readToml());
  return m ? m[1] : '';
}

/// 只返回"真实"的值:仓库模板里的占位符(YOUR_… / REPLACE_WITH_…)算未配置。
/// 公开仓库里的 wrangler.toml 是模板,直接 tomlVar 会把占位符当成配好的值。
function realVar(name) {
  const value = tomlVar(name);
  return value && !isPlaceholder(value) ? value : '';
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

/// 成员要填的「提交地址」= 部署时写进 wrangler.toml 的 SUBMIT_URL(可用环境变量覆盖)。
/// 给的是基地址:引擎自己会拼上 /api/v1/me 与 /api/v1/digests。
/// 仓库模板里的占位符不算已知地址,会退到环境变量;两者都没有就别编造地址。
function submitUrl() {
  return resolveSubmitUrl(tomlVar('SUBMIT_URL'), process.env.DIGEST_SUBMIT_URL);
}

function kvNamespaceId() {
  return /\[\[kv_namespaces\]\][\s\S]*?id\s*=\s*"([0-9a-f]{32})"/.exec(readToml())?.[1] ?? '';
}

/// 原始值(可能是占位符):用于区分"没有绑定块"和"绑定块里是模板占位符"。
function kvNamespaceRaw() {
  return /\[\[kv_namespaces\]\][\s\S]*?id\s*=\s*"([^"]*)"/.exec(readToml())?.[1] ?? '';
}

function d1DatabaseIdRaw() {
  return /\[\[d1_databases\]\][\s\S]*?database_id\s*=\s*"([^"]*)"/.exec(readToml())?.[1] ?? '';
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

/// 读钥匙串。用异步执行:同步 spawn 会阻塞事件循环 —— 它在动画期间被调用时会冻住动画。
async function keychainGet(account, services = FEISHU_SERVICES) {
  for (const service of services) {
    const r = await runAsync('security', ['find-generic-password', '-s', service, '-a', account, '-w']);
    if (r.code === 0 && r.stdout.trim()) return { value: r.stdout.trim(), service };
  }
  return null;
}

async function keychainSet(account, value, service = KEYCHAIN_SERVICE) {
  const r = await runAsync('security', ['add-generic-password', '-s', service, '-a', account, '-w', value, '-U']);
  if (r.code !== 0) {
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

/// 当前动画状态;null 表示没有动画在跑。
let spinnerCtl = null;

/// 暂停动画:提问/画菜单期间必须暂停,否则动画会把提示行覆盖掉。
function pauseSpinner() {
  const ctl = spinnerCtl;
  if (!ctl) return;
  ctl.paused = true;
  if (ctl.interval) { clearInterval(ctl.interval); ctl.interval = null; }
  if (process.stdout.isTTY) process.stdout.write('\r\x1b[0J');
}

/// 恢复动画(提问结束后)。
function resumeSpinner() {
  const ctl = spinnerCtl;
  if (!ctl || !ctl.paused) return;
  ctl.paused = false;
  if (process.stdout.isTTY) { ctl.draw(); ctl.interval = setInterval(ctl.draw, 80); }
}

/// 执行操作时显示旋转动画(仅真终端)。
///   · **立即开始**转动,不延迟;
///   · 动画由 setInterval 驱动,所以被等待的调用**必须异步**(同步 spawn 会让它冻住);
///   · 嵌套调用不重启动画,只把文案换成更具体的那条(避免闪烁与两个定时器抢同一行)。
async function withSpinner(label, fn) {
  if (spinnerCtl) {
    const previous = spinnerCtl.label;
    spinnerCtl.label = label;
    if (!spinnerCtl.paused) spinnerCtl.draw();
    try {
      return await fn();
    } finally {
      spinnerCtl.label = previous;
      if (!spinnerCtl.paused) spinnerCtl.draw();
    }
  }

  const tty = Boolean(process.stdout.isTTY);
  const ctl = { label, frame: 0, interval: null, paused: false, startedAt: Date.now() };
  ctl.draw = () => {
    const frame = SPINNER_FRAMES[ctl.frame++ % SPINNER_FRAMES.length];
    // 超过 3 秒就把已耗时显示出来:否则"网络慢"和"真卡死"从界面上分不出来。
    const elapsed = Math.round((Date.now() - ctl.startedAt) / 1000);
    const suffix = elapsed >= 3 ? ` (${elapsed}s)` : '';
    process.stdout.write(`\r\x1b[2m${frame} ${ctl.label}${suffix}\x1b[0m`);
  };
  spinnerCtl = ctl;
  if (tty) { ctl.draw(); ctl.interval = setInterval(ctl.draw, 80); } else { say(c.dim(`  ${label}…`)); }
  try {
    return await fn();
  } finally {
    if (ctl.interval) clearInterval(ctl.interval);
    if (tty) process.stdout.write('\r\x1b[0J');
    spinnerCtl = null;
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
  pauseSpinner(); // 提示行不能被动画覆盖
  try {
    const answer = (await Promise.race([
      r.question(`${c.bold('?')} ${question}${suffix}: `),
      new Promise((resolve) => r.once('close', () => resolve(null))),
    ]) ?? '').trim();
    return answer || defaultValue;
  } finally {
    resumeSpinner();
  }
}

async function confirm(question, { yes = false } = {}) {
  if (yes) return true;
  const answer = (await ask(`${question} [y/N]`)).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

const closeReader = () => { if (rl) { rl.close(); rl = null; } };

/// 逐个询问只有人能提供的配置值:先把"在哪找"讲清楚,再问。
///
/// 当前值还是模板占位符时**不拿它当默认值** —— 否则用户直接回车,提示里显示"保持原值",
/// 实际却把占位符原样留着,后面照样跑不通。
async function askConfigValue(label, varName, hints) {
  say(`  ── ${label} ──`);
  for (const line of hints) say(c.dim(`     ${line}`));
  const current = tomlVar(varName);
  const real = current && !isPlaceholder(current) ? current : '';
  if (current && !real) say(c.yellow('     当前仍是模板占位符,需要填真实值(直接回车=不改动)'));
  return ask(label, real ? { defaultValue: real } : {});
}

/// 读取密钥类输入:终端下不回显(打 * 号),管道下按普通行读。
async function askSecret(question) {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return (await ask(question)).trim();
  closeReader();
  pauseSpinner();
  if (stdin.isPaused()) stdin.resume();
  process.stdout.write(`${c.bold('?')} ${question}: `);
  return new Promise((resolve) => {
    let buffer = '';
    const finish = (value) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stdout.write('\n');
      resumeSpinner();
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
  const { appSecret } = await resolvedFeishu(flags);
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

async function resolvedFeishu(flags) {
  const appId = flags['app-id'] || realVar('FEISHU_APP_ID') || (await keychainGet('feishu-app-id'))?.value || '';
  const appSecret = flags['app-secret'] || (await keychainGet('feishu-app-secret'))?.value || process.env.FEISHU_APP_SECRET || '';
  return { appId, appSecret };
}

/// 构造共享模块需要的 env(与 Worker 里的 env 形状一致),外加 KV / D1 适配器。
async function buildEnv(flags = {}, { withKv = true, withDb = true } = {}) {
  const { appId, appSecret } = await resolvedFeishu(flags);
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
  const { appId } = await resolvedFeishu(flags);
  if (!appId) fail('缺飞书 App ID:先跑 `feishu`');
  const appSecret = await ensureFeishuSecret(flags);
  const token = await withSpinner('读取飞书通讯录', () => feishuToken(appId, appSecret));
  const extra = (flags['scan-bases'] || process.env.DIGEST_SCAN_BASES || tomlVar('SCAN_BASES') || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return listEmployees(token, extra);
}

/* ------------------------------------------------------------------ 命令 */

async function cmdStatus() {
  const feishu = await resolvedFeishu({});
  const auth = await wranglerAuthState();
  const loginCell = {
    'logged-in': c.green(`已登录${auth.email ? `(${auth.email})` : ''}`),
    'logged-out': c.red('未登录(需要 wrangler login)'),
    error: c.red('wrangler 执行失败(非登录问题,详情见 whoami 输出)'),
  }[auth.state];
  // 仓库里的 wrangler.toml 是公开模板:占位符必须显示成"未配置",
  // 否则会出现「主表 ID  tbl_REPLACE_WITH_YOUR_TABLE_ID」这种像是配好了的假象。
  const rows = [
    ['Cloudflare 登录', loginCell],
    ['飞书 App ID', realVar('FEISHU_APP_ID') ? c.green('已配置') : c.red('未配置(跑 `feishu`)')],
    ['飞书 App Secret', feishu.appSecret ? c.green('已配置(钥匙串/环境变量)') : c.red('未配置(跑 `feishu`,或加 --app-secret)')],
    ['KV 命名空间', kvNamespaceId() ? c.green('已绑定') : (kvNamespaceRaw() ? c.yellow('占位符(需填真实 id)') : c.red('未绑定(跑 `deploy`)'))],
    ['D1 数据库', d1DatabaseName() && /^[0-9a-f-]{36}$/.test(d1DatabaseIdRaw()) ? c.green('已绑定') : (d1DatabaseIdRaw() ? c.yellow('占位符(需填真实 id)') : c.red('未绑定(跑 `deploy`)'))],
    ['主表 token', realVar('BITABLE_APP_TOKEN') ? c.green('已配置') : c.red('未配置(跑 `tables`)')],
    ['主表 ID', realVar('BITABLE_TABLE_ID') ? c.green(realVar('BITABLE_TABLE_ID')) : c.red('未配置(跑 `tables`)')],
    ['定时任务', /crons\s*=/.test(readToml()) ? c.green('每小时清理日志') : c.red('未配置')],
  ];
  say(c.bold('\n当前配置'));
  say(`  ${'wrangler'.padEnd(16)} ${WRANGLER}${/^npx/.test(WRANGLER) ? c.yellow('  ← 走 npx,每次都要问 registry,慢/易卡') : c.dim('  (本机已有)')}`);
  for (const [k, v] of rows) say(`  ${k.padEnd(16)} ${v}`);
  const tracked = localConfigTracked();
  say(`  ${'配置文件'.padEnd(16)} ${path.relative(process.cwd(), TOML_PATH)}${tracked ? c.red('  ← 被 git 跟踪,真实值有泄露风险(见 workers/README.md)') : c.dim('  (未被 git 跟踪)')}`);
  // 模板占位符要单独说清楚:线上 Worker 跑的是部署时的旧配置,
  // 此时再跑 deploy / tables 会把占位符写进线上,直接打断上报。
  const stubs = placeholderLabels([
    ['KV 命名空间 id', kvNamespaceRaw()],
    ['D1 database_id', d1DatabaseIdRaw()],
    ['主表 token', tomlVar('BITABLE_APP_TOKEN')],
    ['主表 ID', tomlVar('BITABLE_TABLE_ID')],
    ['飞书 App ID', tomlVar('FEISHU_APP_ID')],
    ['后端地址', tomlVar('SUBMIT_URL')],
  ]);
  if (stubs.length) {
    warn(`wrangler.toml 里这些还是仓库模板的占位符:${stubs.join('、')}`);
    say(c.dim('    线上 Worker 跑的是部署时写入的旧配置,现在仍然正常;'));
    say(c.dim('    但在补齐真实值之前不要跑 `deploy` / `tables`,否则会把占位符写进线上,直接打断上报。'));
    say(c.dim('    取回真实值:'));
    say(c.dim('      KV 命名空间 id   npx wrangler kv namespace list(KEYS 那条的 id)'));
    say(c.dim('      D1 database_id   npx wrangler d1 list(daily-agent-digest-logs 那条)'));
    say(c.dim('      主表 token / 主表 ID / 飞书 App ID   Cloudflare 控制台里该 Worker 的变量(部署时写入的旧值)'));
    say(c.dim('      后端地址         就是 Worker 地址(托盘菜单「设置」里的提交地址通常已经填着它)'));
  }
  const url = submitUrl();
  if (url) {
    // 用异步执行:同期的 curl 也会阻塞事件循环,把动画冻住
    // 注意:runAsync 返回 code(不是 spawnSync 的 status)—— 这里曾写错,导致恒显示"不可达"
    const r = await withSpinner('检查后端健康', () => runAsync('curl', ['-sS', '-w', '\n%{http_code}', `${url.replace(/\/$/, '')}/healthz`]));
    say(`  ${'后端地址'.padEnd(16)} ${url}`);
    const healthLines = (r.stdout ?? '').trim().split('\n');
    const httpCode = (healthLines.pop() ?? '').trim();
    const healthBody = healthLines.join(' ').replace(/\s+/g, ' ').trim();
    if (r.code !== 0) {
      const reason = (r.stderr ?? '').trim().split('\n')[0] || `curl 退出码 ${r.code}`;
      say(`  ${'后端健康'.padEnd(16)} ${c.red('不可达')} ${c.dim(reason)}`);
    } else if (httpCode && httpCode !== '200') {
      say(`  ${'后端健康'.padEnd(16)} ${c.red(`HTTP ${httpCode}`)} ${c.dim(healthBody.slice(0, 100))}`);
    } else {
      say(`  ${'后端健康'.padEnd(16)} ${c.green('正常')} ${c.dim(healthBody.slice(0, 100))}`);
    }
  } else {
    say(`  ${'后端地址'.padEnd(16)} ${c.red('未知(部署后写入 wrangler.toml 的 SUBMIT_URL)')}`);
  }
}

async function cmdFeishu(flags) {
  await requireLogin();
  // 占位符不算已配置:否则会拿 cli_REPLACE_WITH_YOUR_APP_ID 去飞书换 token,报错莫名其妙。
  let appId = flags['app-id'] || realVar('FEISHU_APP_ID') || (await keychainGet('feishu-app-id'))?.value || '';
  let appSecret = flags['app-secret'] || (await keychainGet('feishu-app-secret'))?.value || '';

  // 已配置的值作为默认值直接显示,回车即沿用
  if (!appId) {
    say(c.dim('    在哪找:飞书开放平台 → 开发者后台 → 该应用 → 凭证与基础信息 → App ID(形如 cli_…)'));
    say(c.dim('    也可以从 Cloudflare 控制台该 Worker 的 Variables(FEISHU_APP_ID)里抄回旧值。'));
    appId = (await ask('飞书 App ID (cli_…)')).trim();
  }
  if (!appId.startsWith('cli_')) fail(`App ID 看起来不对:${appId}(应以 cli_ 开头)`);
  const hadSecret = Boolean(appSecret);
  if (!appSecret) {
    say(c.dim('    在哪找:同一页「凭证与基础信息」里的 App Secret(点「查看」复制)。'));
    say(c.dim('    线上那份存在 Cloudflare secret 里,读不回明文;这里填的是本机 CLI 直连飞书用的。'));
    appSecret = await askSecret('飞书 App Secret(输入不回显)');
    if (!appSecret) fail('缺少 App Secret');
  }

  await withSpinner('校验飞书凭据', () => feishuToken(appId, appSecret));
  ok(`飞书凭据有效(App ID ${appId.slice(0, 12)}…)`);

  if (tomlVar('FEISHU_APP_ID') !== appId) {
    setTomlVar('FEISHU_APP_ID', appId);
    ok(`已写入 wrangler.toml 的 FEISHU_APP_ID(${appId})`);
  } else {
    ok(`FEISHU_APP_ID:${appId}`);
  }
  if (hadSecret && flags['keep-secret']) {
    ok('沿用现有的 FEISHU_APP_SECRET');
    return;
  }
  const r = await withSpinner('写入 Worker secret FEISHU_APP_SECRET', () => wrangler(['secret', 'put', 'FEISHU_APP_SECRET'], { input: appSecret }));
  if (r.code !== 0) fail(`写入 secret 失败:${r.out.trim()}`);
  ok('FEISHU_APP_SECRET 已写入 Cloudflare');
  say(c.dim('  免输入可选:'));
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
  } else if (!kvNamespaceId()) {
    // 绑定块在、id 却是占位符(公开仓库模板就是这样)。这里**绝不能**当成"没绑定"去新建:
    // 新命名空间里没有已签发的 Key,所有成员会立刻无法提交。必须让操作员填回真实 id。
    fail(`wrangler.toml 里的 KV 命名空间 id 不是合法 id(当前值:${kvNamespaceRaw() || '空'})。
  这多半是公开仓库模板的占位符。请填回真实 id(npx wrangler kv namespace list),不要新建 —— 新建会丢掉已签发的 Key。`);
  } else ok('KV 已绑定,跳过');

  if (!hasBinding('d1_databases')) {
    const r = await withSpinner('创建 D1 数据库', () => wrangler(['d1', 'create', D1_NAME]));
    const id = /database_id\s*=\s*"([0-9a-f-]{36})"/.exec(r.out ?? '')?.[1];
    if (!id) fail(`创建 D1 失败:${(r.out ?? '').trim()}`);
    appendBinding(`# 审计日志(提交/签发/撤销)持久化在 D1。\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "${D1_NAME}"\ndatabase_id = "${id}"`);
    ok(`D1 已创建并写入 wrangler.toml(${id})`);
  } else if (!/^[0-9a-f-]{36}$/.test(d1DatabaseIdRaw())) {
    fail(`wrangler.toml 里的 D1 database_id 不是合法 id(当前值:${d1DatabaseIdRaw() || '空'})。
  这多半是公开仓库模板的占位符。请填回真实 id(npx wrangler d1 list),不要新建 —— 新建会丢掉已有审计日志。`);
  } else ok('D1 已绑定,跳过');

  const schema = await withSpinner('应用 schema.sql(建 audit_log 表)', () => wrangler(['d1', 'execute', D1_NAME, '--remote', '--file=schema.sql']));
  if (schema.code !== 0) fail(`建表失败:${(schema.out ?? '').trim()}`);
  ok('audit_log 表已就绪');

  const deploy = await withSpinner('部署 Worker', () => wrangler(['deploy']));
  if (deploy.code !== 0) fail(`部署失败:${(deploy.out ?? '').trim()}`);
  const url = parseDeployedUrl(deploy.out ?? '', tomlVar('name'));
  if (url) { setTomlVar('SUBMIT_URL', url); ok(`后端已部署:${url}`); }
  else warn('部署成功但没解析到地址,请手动把 SUBMIT_URL 写进 wrangler.toml');
}

/// 用飞书接口校验刚写下的 app_token / table_id,并在缺表 id 时按表名自动补上。
///
/// 这一步的价值:token 粘错、表 id 不对、应用没有该表的权限,都会立刻变成一条
/// 看得懂的报错,而不是等到跑 tables / employees 时才失败。
async function verifyFeishuAndFillTable(flags) {
  const feishu = await resolvedFeishu(flags);
  const appToken = realVar('BITABLE_APP_TOKEN');
  if (!appToken) return;
  if (!feishu.appId || !feishu.appSecret) {
    warn('跳过飞书校验:本机没有 App ID / App Secret。');
    say(c.dim('    补一次即可(仅本机 CLI 用):'));
    say(c.dim(`      security add-generic-password -s ${KEYCHAIN_SERVICE} -a feishu-app-secret -w`));
    say(c.dim('      node workers/scripts/digest-admin.mjs feishu'));
    return;
  }
  const env = { BITABLE_APP_TOKEN: appToken, FEISHU_APP_ID: feishu.appId, FEISHU_APP_SECRET: feishu.appSecret };
  let tables;
  try {
    tables = await withSpinner('用飞书接口校验表格 token', () => listTables(env));
  } catch (err) {
    warn(`飞书校验失败:${err?.message ?? err}`);
    say(c.dim('    常见原因:token 粘错、应用没有这张表的权限(需要在表里把应用加为协作者)。'));
    return;
  }
  const names = tables.map((t) => String(t.name ?? '')) .filter(Boolean);
  ok(`飞书校验通过:该 base 下有 ${tables.length} 张表${names.length ? `(${names.slice(0, 4).join('、')}${names.length > 4 ? '…' : ''})` : ''}`);

  const wanted = realVar('BITABLE_TABLE_ID');
  if (wanted) {
    if (!tables.some((t) => t.table_id === wanted)) {
      warn(`配置里的表 id ${wanted} 不在这个 base 里:表 id 或 app_token 有一个不对。`);
    }
    return;
  }
  // 没给表 id:按表名找(与 bootstrap 的行为一致,少问一个问题)
  const tableName = tomlVar('BITABLE_TABLE_NAME') || '日报明细';
  const hit = tables.find((t) => String(t.name ?? '').trim() === tableName);
  if (hit) {
    setTomlVar('BITABLE_TABLE_ID', hit.table_id);
    ok(`按表名「${tableName}」补上 table_id = ${hit.table_id}`);
  } else {
    warn(`这个 base 里没有名为「${tableName}」的表:跑 \`tables\` 会按这个名字建一张,或把表 id 直接填进配置。`);
  }
}


/// 把 id 写进对应的绑定块(块存在就改其中的 id,不存在才追加整块)。
function setBindingValue(kind, key, value, blockText) {
  let toml = readToml();
  const re = new RegExp(`(\\[\\[${kind}\\]\\][\\s\\S]*?${key}\\s*=\\s*")[^"]*(")`);
  if (re.test(toml)) toml = toml.replace(re, `$1${value}$2`);
  else toml += `\n${blockText}\n`;
  writeFileSync(TOML_PATH, toml);
}

/// 从线上正在跑的版本里读回配置(恢复流程的主路径)。
///
/// 不依赖本机任何历史文件:换机器、换人、本地全空也一样成立 ——
/// 值就是 Cloudflare 上那个版本自己带着的绑定。
///
/// 返回 { ok, bindings?, reason? }。**失败必须带原因**:以前这里把 wrangler 的
/// 报错直接吞掉,于是"查询失败"被显示成"账号里没有部署",把人引向错误的方向。
async function readDeployedBindings() {
  const status = await withSpinner('读取 Cloudflare 上的当前部署', () => wrangler(['deployments', 'status', '--json']));
  if (status.code !== 0) return { ok: false, reason: firstErrorLine(status) || 'wrangler deployments status 失败' };
  const versionId = activeVersionId(status.out ?? '');
  if (!versionId) return { ok: false, reason: '该 Worker 在这个账号下没有可用版本(或名字对不上)' };
  const view = await withSpinner(`读取版本 ${versionId.slice(0, 8)}… 的绑定`, () => wrangler(['versions', 'view', versionId, '--json']));
  if (view.code !== 0) return { ok: false, reason: firstErrorLine(view) || 'wrangler versions view 失败' };
  const bindings = bindingsFromVersion(view.out ?? '');
  const total = Object.keys(bindings.vars).length + Object.keys(bindings.kv).length + Object.keys(bindings.d1).length;
  if (!total) return { ok: false, reason: `版本 ${versionId.slice(0, 8)}… 里没有任何可用绑定` };
  return { ok: true, versionId, ...bindings };
}

/// wrangler 失败时的第一行有用信息(跳过空行与 fetch 代理之类的噪音)。
function firstErrorLine(result) {
  const text = `${result?.stderr ?? ''}\n${result?.stdout ?? ''}`;
  const line = text.split('\n').map((l) => l.trim())
    .find((l) => l && !/^(Proxy environment variables|Getting User settings|⛅️|─+$)/.test(l));
  return (line ?? '').slice(0, 200);
}

/// 当前登录的账号信息,用于"是不是登错账号了"这类排查。
async function currentAccount() {
  const r = await wrangler(['whoami']);
  const info = parseWhoamiAccounts(`${r.stdout ?? ''}\n${r.stderr ?? ''}`);
  return { ...info, ok: r.code === 0 };
}

/// 恢复到已有部署:把自己能从线上读到的全部读回来;
/// 读不到的(飞书 App Secret)才提示人去补。
async function cmdAdopt(flags) {
  await requireLogin();
  ensureLocalConfig();
  say(c.bold('\n恢复到已有部署'));
  say(c.dim('    写回本地配置 workers/wrangler.toml(该文件不被 git 跟踪)。'));

  // 主路径:从线上版本读回 KV / D1 / 所有明文变量(URL、表 token、表 id、App ID…)
  const deployed = await readDeployedBindings();
  if (deployed.ok) {
    const written = [];
    const vars = deployed.vars ?? {};
    for (const name of ['SUBMIT_URL', 'BITABLE_APP_TOKEN', 'BITABLE_TABLE_ID', 'FEISHU_APP_ID', 'BITABLE_TABLE_NAME', 'SCAN_BASES']) {
      const value = vars[name];
      if (typeof value === 'string' && value.trim() && !isPlaceholder(value)) { setTomlVar(name, value.trim()); written.push(name); }
    }
    const kvId = deployed.kv?.KEYS || flags['kv-id'] || '';
    if (kvId) { setBindingValue('kv_namespaces', 'id', kvId, `[[kv_namespaces]]\nbinding = "KEYS"\nid = "${kvId}"`); written.push('KV id'); }
    const d1Id = deployed.d1?.DB || flags['d1-id'] || '';
    if (d1Id) { setBindingValue('d1_databases', 'database_id', d1Id, `[[d1_databases]]\nbinding = "DB"\ndatabase_name = "${D1_NAME}"\ndatabase_id = "${d1Id}"`); written.push('D1 id'); }
    ok(`从线上版本 ${deployed.versionId.slice(0, 8)}… 读回:${written.length ? written.join('、') : '(空)'}`);
    if (!written.length) warn('这个版本里没有可用的明文配置(可能部署时就没写 vars)。');
  } else {
    warn(`没能从线上读回配置:${deployed.reason}`);
    if (/没有可用版本|名字对不上/.test(deployed.reason)) {
      say(c.dim(`    核对 wrangler.toml 里的 name(当前:${tomlVar('name') || '空'})是否与 Cloudflare 上那个 Worker 同名,`));
      say(c.dim('    以及当前登录的是不是部署它的账号(wrangler whoami)。'));
    }
  }

  // 线上读不到 KV / D1 时,退回到"按名字找"。
  // 关键:必须分清"命令失败"和"账号里确实没有" —— 以前两者都显示成"没有",
  // 于是登录态/权限问题被误报成"这份部署从未跑过 deploy"。
  let kvQueryFailed = '';
  let d1QueryFailed = '';
  let kvTitles = [];
  let d1Names = [];
  if (!kvNamespaceId() || !/^[0-9a-f-]{36}$/.test(d1DatabaseIdRaw())) {
    const kvOut = await withSpinner('在 Cloudflare 上找 KV 命名空间 KEYS', () => wrangler(['kv', 'namespace', 'list']));
    if (kvOut.code !== 0) kvQueryFailed = firstErrorLine(kvOut) || 'wrangler kv namespace list 失败';
    else kvTitles = kvNamespaceTitles(kvOut.out ?? '');
    const kvId = kvNamespaceId() || flags['kv-id'] || (kvQueryFailed ? '' : pickKvNamespaceId(kvOut.out ?? ''));
    if (kvId) setBindingValue('kv_namespaces', 'id', kvId, `[[kv_namespaces]]\nbinding = "KEYS"\nid = "${kvId}"`);
    const d1Out = await withSpinner('在 Cloudflare 上找 D1 数据库', () => wrangler(['d1', 'list', '--json']));
    if (d1Out.code !== 0) d1QueryFailed = firstErrorLine(d1Out) || 'wrangler d1 list 失败';
    else d1Names = d1DatabaseNames(d1Out.out ?? '');
    const d1Id = (/^[0-9a-f-]{36}$/.test(d1DatabaseIdRaw()) ? d1DatabaseIdRaw() : '') || flags['d1-id'] || (d1QueryFailed ? '' : pickD1DatabaseId(d1Out.out ?? ''));
    if (d1Id) setBindingValue('d1_databases', 'database_id', d1Id, `[[d1_databases]]\nbinding = "DB"\ndatabase_name = "${D1_NAME}"\ndatabase_id = "${d1Id}"`);
    if (!kvId) {
      if (kvQueryFailed) warn(`查询 KV 失败:${kvQueryFailed}`);
      else warn(kvTitles.length
        ? `账号里没有叫 KEYS 的 KV 命名空间。现有:${kvTitles.join('、')}`
        : '这个账号里一个 KV 命名空间都没有。');
      say(c.dim('    确认真实 id 后指定:npx wrangler kv namespace list,再 --kv-id <32位id>'));
    }
    if (!d1Id) {
      if (d1QueryFailed) warn(`查询 D1 失败:${d1QueryFailed}`);
      else warn(d1Names.length
        ? `账号里没有叫 ${D1_NAME} 的 D1 数据库。现有:${d1Names.join('、')}`
        : '这个账号里一个 D1 数据库都没有。');
      say(c.dim('    确认真实 id 后指定:npx wrangler d1 list,再 --d1-id <uuid>'));
    }
    // 三处都空且都不是"查询失败":几乎可以断定登错了账号 —— 这时不该再追问地址,
    // 先把账号事实摆出来,并让人换账号重来。
    const nothingHere = !kvQueryFailed && !d1QueryFailed && !kvTitles.length && !d1Names.length
      && !kvNamespaceId() && !/^[0-9a-f-]{36}$/.test(d1DatabaseIdRaw());
    if (nothingHere) {
      const acct = await currentAccount();
      say('');
      warn('这个账号里既没有部署过的 Worker,也没有任何 KV / D1 —— 大概率不是部署这个后端的账号。');
      if (acct.email) say(`    当前登录:${acct.email}${acct.accounts.length ? `(账号 ${acct.accounts.map((a) => `${a.name} / ${a.id.slice(0, 8)}…`).join('、')})` : ''}`);
      say(c.dim('    请换成当时部署用的账号再跑一次:'));
      say(c.dim('      npx --yes wrangler logout && npx --yes wrangler login'));
      say(c.dim('    或者用那个账号的 API Token:export CLOUDFLARE_API_TOKEN=…(再跑本命令)'));
      say(c.dim('    如果你确实知道各项的值,也可以直接指定:'));
      say(c.dim('      node workers/scripts/digest-admin.mjs adopt --kv-id <32位id> --d1-id <uuid> --submit-url https://… '));
      if (!flags['kv-id'] && !flags['d1-id'] && !flags['submit-url']) {
        fail('恢复所需的信息都不在当前账号里:请先换账号,或用上面的参数手动指定。');
      }
    }
  }
  ok(`KV ${kvNamespaceId() || c.red('未找到')}  ${c.dim(`D1 ${/^[0-9a-f-]{36}$/.test(d1DatabaseIdRaw()) ? d1DatabaseIdRaw() : c.red('未找到')}`)}`);

  // 只有线上**确实缺**的东西才问人。刚才都读回来了就一个都不问 ——
  // 恢复流程不该让人回答本来能从云上拿到的问题。
  const currentToken = realVar('BITABLE_APP_TOKEN');
  let appToken = '';
  let tableId = '';
  const wantBitable = Boolean(flags['base-url'] || flags['base-token']) || !currentToken || !realVar('BITABLE_TABLE_ID');
  if (wantBitable) {
    say('  ── 飞书多维表格 ──');
    say(c.dim('     在飞书里打开那张日报表,把地址栏整条粘进来即可(两种写法都认):'));
    say(c.dim('       https://<租户>.feishu.cn/base/<app_token>?table=<table_id>'));
    say(c.dim('       https://<租户>.feishu.cn/wiki/<node_token>   (知识库里的表,会自动换算)'));
    say(c.dim('     也可以只粘 app_token / table_id。直接回车=不改动。'));
    if (currentToken) say(c.dim(`     当前:${currentToken}`));
    const bitableInput = flags['base-url'] ?? flags['base-token'] ?? await ask('飞书多维表格链接(或 app_token / table id)', currentToken ? { defaultValue: currentToken } : {});
    const parsed = parseBitableInput(bitableInput);
    appToken = parsed.appToken;
    tableId = parsed.tableId;

    // 知识库链接:给的是 node_token,需要换算成真正的 app_token
    if (parsed.kind === 'wiki') {
      const feishu = await resolvedFeishu(flags);
      if (!feishu.appId || !feishu.appSecret) {
        fail('这是知识库(Wiki)链接,里面只有 node_token,需要飞书凭据才能换算成表格 token。\n  请改用 /base/ 形式的链接(在飞书里单独打开那张表),或先跑 `feishu` 配置 App ID / Secret。');
      }
      const node = await withSpinner('换算知识库节点 → 表格 token', () => resolveWikiNode({ FEISHU_APP_ID: feishu.appId, FEISHU_APP_SECRET: feishu.appSecret }, parsed.nodeToken));
      if (!node.objToken) fail(`换算失败:知识库节点 ${parsed.nodeToken} 没有返回表格 token。`);
      if (node.objType && node.objType !== 'bitable') {
        warn(`该知识库节点的类型是 ${node.objType},不是多维表格(bitable),请确认链接指向的是那张日报表。`);
      }
      appToken = node.objToken;
      ok(`知识库节点 → app_token ${appToken}${node.title ? `(${node.title})` : ''}`);
    }
    if (appToken) ok(`解析到 app_token = ${appToken}`);
    if (tableId) ok(`解析到 table_id = ${tableId}`);
    if (!appToken && !tableId && bitableInput.trim()) {
      warn(`没能从「${bitableInput.trim().slice(0, 80)}」里认出 app_token 或 table_id:请确认粘的是多维表格地址栏里的链接。`);
    }
  }

  const appId = realVar('FEISHU_APP_ID') || flags['app-id']
    || await askConfigValue('飞书 App ID', 'FEISHU_APP_ID', [
      '飞书开放平台 → 开发者后台 → 该应用 → 凭证与基础信息 → App ID(形如 cli_…)',
      'App ID 不敏感;App Secret 只在 CLI 直连飞书时用,填不进这里(见文末提示)',
    ]);
  const submitUrlInput = knownSubmitUrl(tomlVar('SUBMIT_URL')) || flags['submit-url']
    || await askConfigValue('后端提交地址(Worker 地址)', 'SUBMIT_URL', [
      'Cloudflare 控制台 → Workers & Pages → 这个 Worker → 概览里的 *.workers.dev 地址',
      '或:跑一次 `deploy`,结尾会打印“后端已部署:https://…”并写回配置',
      '形如 https://<worker>.<子域>.workers.dev,填到域名即可(不要带 /api/v1/digests)',
    ]);

  const previousToken = currentToken;
  if (appToken) setTomlVar('BITABLE_APP_TOKEN', appToken);
  if (tableId) setTomlVar('BITABLE_TABLE_ID', tableId);
  else if (appToken && previousToken && appToken !== previousToken) {
    // 换了 base 又没在链接里给表 id:旧 table_id 属于上一个 base,留着反而会误导,
    // 清空后由下面的校验按表名重找。
    setTomlVar('BITABLE_TABLE_ID', '');
    say(c.dim('     换了 base 且链接里没有 ?table=:已清空旧表 id,稍后按表名重新定位。'));
  }
  for (const [name, value] of [['FEISHU_APP_ID', appId], ['SUBMIT_URL', submitUrlInput]]) {
    const trimmed = String(value ?? '').trim();
    if (trimmed && !isPlaceholder(trimmed)) setTomlVar(name, trimmed);
  }
  ok(`已写入 ${path.relative(process.cwd(), TOML_PATH)}`);

  // 用飞书接口把刚填的东西验一遍:token 错、表 id 错、缺权限都会在这里暴露,
  // 而不是等到跑 tables/employees 时才报一个看不懂的错。
  await verifyFeishuAndFillTable(flags);

  // 地址能立刻验一下:填错的话这里就能看出来
  const url = submitUrl();
  if (url) {
    const r = await withSpinner('校验后端地址', () => runAsync('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', `${url.replace(/\/$/, '')}/healthz`]));
    const code = (r.stdout ?? '').trim();
    if (r.code === 0 && code === '200') ok(`后端可达:${url}`);
    else warn(`后端暂不可达(HTTP ${code || r.code}):${url} —— 地址可能不对,或 Worker 未部署`);
  }
  say(c.dim('\n  接着建议:'));
  say(c.dim('    1) node workers/scripts/digest-admin.mjs status        # 复核,占位符警告应消失'));
  say(c.dim('    2) 本地飞书 App Secret(仅 CLI 直连飞书要用):'));
  say(c.dim(`       security add-generic-password -s ${KEYCHAIN_SERVICE} -a feishu-app-secret -w`));
}

async function cmdTables(flags) {
  await requireLogin();
  const env = await buildEnv(flags, { withKv: true, withDb: true });
  const result = await withSpinner('直连飞书建表 / 建字段', () => bootstrapLocally(env));
  ok(`主表 ${result.tableId}`);
  if (result.created.length) say(c.dim(`    新建:${result.created.join(', ')}`));

  if (tomlVar('BITABLE_TABLE_ID') !== result.tableId) {
    setTomlVar('BITABLE_TABLE_ID', result.tableId);
    ok(`已写回 wrangler.toml(BITABLE_TABLE_ID=${result.tableId})`);
  } else {
    ok(`BITABLE_TABLE_ID:${result.tableId}`);
  }

  const deploy = await withSpinner('重新部署以让 Worker 读到表 id', () => wrangler(['deploy']));
  if (deploy.code !== 0) fail(`部署失败:${(deploy.out ?? '').trim()}`);
  ok('已重新部署');
}

async function cmdEmployees(flags) {
  const people = await withSpinner('读取员工名单', () => fetchEmployees(flags));
  if (!people.length) fail('没找到任何员工(人员字段为空?)');
  say(c.bold(`\n共 ${people.length} 人`));
  say(c.dim(`  ${padEndWidth('姓名', 16)}${padEndWidth('open_id', 38)}读到的位置`));
  for (const p of people) {
    const where = p.sources.length > 1 ? `${p.sources[0]} 等${p.sources.length}处` : p.sources[0];
    say(`  ${padEndWidth(p.name, 16)}${p.open_id}   ${c.dim(where)}`);
  }
  say(c.dim('  第三列:该 open_id 读自哪张表。'));
  say('');
}

async function cmdIssue(flags) {
  await requireLogin();
  const env = await buildEnv(flags);

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
  // 提示行由 issue-report.mjs 生成(纯函数,有单测):Key 只显示一次,
  // 同时必须给出本人要对接的提交地址,否则对方拿到 Key 也不知道往哪提交。
  for (const [kind, text] of issueReportLines(label, issued, submitUrl())) {
    if (kind === 'ok') ok(text);
    else if (kind === 'warn') warn(text);
    else if (kind === 'dim') say(c.dim(text));
    else say(text);
  }
}

async function cmdKeys(flags) {
  await requireLogin();
  const keys = await withSpinner('读取 Key 列表', async () => listKeysLocally(await buildEnv(flags, { withDb: false })));
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
  const env = await buildEnv(flags);
  const revoked = await withSpinner(`撤销 ${keyId}`, () => revokeLocally(env, keyId));
  ok(`已撤销 ${revoked.key_id}(${revoked.member ?? ''}),下一次请求立即失效`);
}

async function cmdLogs(flags) {
  await requireLogin();
  const rows = await withSpinner('查询审计日志', async () => logsLocally(await buildEnv(flags, { withKv: false }), {
    limit: flags.limit ?? 100,
    memberId: flags.member,
    date: flags.date,
    event: flags.event,
    outcome: flags.outcome,
  }));
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
  say(c.dim('已配置的步骤会显示当前值并默认跳过。\n'));
  await requireLogin(); // 未登录会自动拉起 wrangler login

  // 凭据只解析一次(要读钥匙串),供下面的摘要复用
  const creds = await resolvedFeishu(flags);

  // 每一步的"当前配置"摘要:已配置的直接展示出来,作为是否重做的判断依据
  const summaries = {
    feishu: () => {
      // 占位符不算已配置:否则一键全流程会把仓库模板当成"配好了"直接跳过。
      const id = realVar('FEISHU_APP_ID');
      const secret = creds.appSecret;
      if (!id || !secret) return null;
      return `App ID ${id};App Secret ${c.dim('已配置(钥匙串/环境变量)')}`;
    },
    deploy: () => {
      const kv = kvNamespaceId();
      // D1 必须是真实 id:绑定块在、值是占位符时同样算未配置。
      const d1 = d1DatabaseName() && /^[0-9a-f-]{36}$/.test(d1DatabaseIdRaw()) ? d1DatabaseName() : '';
      const url = knownSubmitUrl(tomlVar('SUBMIT_URL'));
      if (!kv || !d1) return null;
      return `KV ${kv.slice(0, 8)}…;D1 ${d1}${url ? `;地址 ${url}` : ''}`;
    },
    tables: () => {
      const main = realVar('BITABLE_TABLE_ID');
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
  const people = await withSpinner('读取员工名单', () => fetchEmployees(flags));
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
  pauseSpinner(); // 菜单绘制期间不能让动画抢同一行
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
      resumeSpinner();
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
  const env = await buildEnv(flags);
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
    { label: '轮换:签发新 Key,旧的立即失效', value: 'rotate' },
    { label: '撤销:停用,该成员将无法提交', value: 'revoke' },
    { label: '取消', value: 'cancel' },
  ], { prompt: `「${person.name}」已有 Key`, footer: '↑/↓ 移动 · Enter 确认 · q 取消' });

  if (!action || action.value === 'cancel') return warn('已取消');

  if (action.value === 'revoke') {
    const revoked = await withSpinner(`撤销 ${key.key_id}`, () => revokeLocally(env, key.key_id));
    return ok(`已撤销 ${revoked.key_id}(${revoked.member ?? ''}),下一次请求立即失效`);
  }

  const issued = await withSpinner(`轮换「${person.name}」的 Key`, () => issueLocally(env, {
    member_id: key.member_id || person.open_id.slice(-6),
    member: person.name,
    open_id: person.open_id,
  }));
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
    ['建飞书表并回填 table id', (f) => cmdTables(f)],
  ]],
  ['恢复与迁移', [
    ['恢复到已有部署(自动找回 KV / D1 的 id)', (f) => cmdAdopt(f)],
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
  const items = [];
  for (const [section, entries] of MENU_SECTIONS) {
    items.push({ header: section });
    for (const [label, run] of entries) items.push({ label, run });
  }

  say(c.bold('\n日报上报后端 · 管理台'));
  say(c.dim('  直连 KV / D1 / 飞书执行。'));
  await tryAutoLogin(); // 横幅之后再检查:未登录会自动拉起 wrangler login
  for (;;) {
    say('');
    const picked = await choose(items, { prompt: '请选择功能', footer: '↑/↓ 移动 · Enter 确认 · q 退出' });
    if (!picked) { say('已退出。'); return; }
    say('');
    try {
      // 整个动作都包在动画里:点击后立刻有反馈;内部更具体的文案会替换掉这条
      await withSpinner(picked.label, () => picked.run(flags));
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
  adopt: cmdAdopt,
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
  adopt            恢复到已有部署:自动找回 KV / D1 的 id 并写回本地配置
  tables           建飞书表 → 回填 table id → 重新部署 → 配置表单
  members          员工与 Key 合并视图(列出 / 签发 / 轮换 / 撤销)
  employees        只列出员工(含 open_id 与来源)
  issue            选员工生成 Key(交互式;或 --open-id/--email/--name/--member-id)
  keys             列出已签发的 Key
  revoke <key_id>  撤销某把 Key
  logs             查询审计日志(--member/--date/--event/--outcome/--limit)

安全:建表/发 Key/撤销/查日志均在本机直连 KV / D1 / 飞书,
      需要 Cloudflare 登录(wrangler login 或 CLOUDFLARE_API_TOKEN)与本机飞书 App Secret。

选项:
  --yes                  全部确认(非交互)
  --app-id/--app-secret  直接给飞书凭据
  --admin-open-id        配置表单时把该用户加为 base 协作者
  --scan-bases token:名  额外扫描的 base(员工在别人共享的表里时用)
  --keep-secret          飞书凭据已存在时只校验,不改写 Cloudflare secret

环境变量:WRANGLER_CMD(覆盖 wrangler 调用方式;默认优先用本机已有的 wrangler)、
          DIGEST_WRANGLER_TIMEOUT(秒,默认 60)、DIGEST_SUBMIT_URL、DIGEST_SCAN_BASES、CLOUDFLARE_API_TOKEN
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
