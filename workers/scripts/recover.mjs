/// 从 wrangler 的列表输出里找回已有部署的 id。
///
/// 用途:配置被清理 / 换机器之后,不必让人手抄 32 位 KV id 与 D1 uuid ——
/// 这两个值都能从 Cloudflare 直接查回来:
///   · `wrangler kv namespace list` 默认就打印 JSON(实现里是 JSON.stringify);
///   · `wrangler d1 list --json` 打印干净 JSON。
///
/// 抽成纯函数是为了能单测:不连 Cloudflare 也能覆盖真实输出形状(含前后夹杂日志行)。

/// 从输出里取出 JSON 数组。npx 有时会在 stdout 前后带上别的内容,
/// 所以解析失败时退化成"截取第一个 [ 到最后一个 ]"再试一次。
function parseArray(text) {
  const raw = String(text ?? '');
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // 落到下面的截取逻辑
  }
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/// 找出指定名字的 KV 命名空间 id(必须形如 32 位十六进制)。
export function pickKvNamespaceId(kvListOutput, title = 'KEYS') {
  const list = parseArray(kvListOutput);
  const hit = list.find((item) => item && String(item.title ?? '').trim() === title);
  const id = hit ? String(hit.id ?? '').trim() : '';
  return /^[0-9a-f]{32}$/.test(id) ? id : '';
}

/// 找出指定名字的 D1 数据库 id(必须形如 uuid)。
export function pickD1DatabaseId(d1ListOutput, name = 'daily-agent-digest-logs') {
  const list = parseArray(d1ListOutput);
  const hit = list.find((item) => item && String(item.name ?? '').trim() === name);
  // wrangler d1 list 用 uuid;旧版本/API 里也可能叫 database_id。
  const id = hit ? String(hit.uuid ?? hit.database_id ?? '').trim() : '';
  return /^[0-9a-f-]{36}$/.test(id) ? id : '';
}

/// 账号里现有的 KV 命名空间名字,按名字找不到时列出来给人看(好让他用 --kv-id 指定)。
export function kvNamespaceTitles(kvListOutput) {
  return parseArray(kvListOutput)
    .map((item) => String(item?.title ?? '').trim())
    .filter(Boolean);
}

/// 账号里现有的 D1 数据库名字,同上。
export function d1DatabaseNames(d1ListOutput) {
  return parseArray(d1ListOutput)
    .map((item) => String(item?.name ?? '').trim())
    .filter(Boolean);
}

/// 从飞书多维表格的链接(或直接粘的 id)里解析出 app_token 与 table_id。///
/// 用户手上只有一条地址栏 URL,却要为 app_token 和 table_id 回答两个问题 ——
/// 那两个值本来就在同一条 URL 里,拆不出人情味:(token 在 /base/ 之后,表 id 在 ?table= 之后)
///
/// 支持三种输入:
///   1. 完整链接   https://<租户>.feishu.cn/base/<app_token>?table=<table_id>&view=…
///   2. 知识库链接 https://<租户>.feishu.cn/wiki/<node_token>?table=<table_id>
///      —— wiki 给的是 node_token,不是 app_token,需要再调一次接口换算(kind='wiki')
///   3. 直接粘 id   app_token 或 table_id
export function parseBitableInput(input) {
  const raw = String(input ?? '').trim().replace(/^<|>$/g, '');
  const result = { appToken: '', tableId: '', nodeToken: '', kind: 'unknown' };
  if (!raw) return result;

  // 纯 id:没有斜杠/空白
  if (!/[/\s]/.test(raw)) {
    if (/^tbl[A-Za-z0-9]{6,}$/.test(raw)) { result.tableId = raw; result.kind = 'tableId'; return result; }
    if (/^[A-Za-z0-9_-]{10,64}$/.test(raw)) { result.appToken = raw; result.kind = 'appToken'; return result; }
    return result;
  }

  let url = null;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { url = null; }
  const path = url ? url.pathname : raw;
  const search = url ? `${url.search}${url.hash}` : (raw.includes('?') ? raw.slice(raw.indexOf('?')) : '');

  const base = /\/(?:base|bitable)\/([A-Za-z0-9_-]+)/.exec(path);
  const wiki = /\/wiki\/([A-Za-z0-9_-]+)/.exec(path);
  if (base) { result.appToken = base[1]; result.kind = 'base'; }
  else if (wiki) { result.nodeToken = wiki[1]; result.kind = 'wiki'; }

  const table = /[?&#]table=([A-Za-z0-9_-]+)/.exec(search);
  if (table) result.tableId = table[1];
  return result;
}


// ---- 从线上已部署的版本里读回配置 ----------------------------------------
//
// 这是恢复配置的**主路径**:换机器、换人、本地什么都没留下时,唯一权威的来源就是
// Cloudflare 上正在跑的那个版本。wrangler 能把它整份吐出来:
//
//   wrangler deployments status --json     → { versions: [{ version_id, percentage }] }
//   wrangler versions view <version_id> --json
//        → { resources: { bindings: [
//              { name: 'SUBMIT_URL', type: 'plain_text', text: 'https://…' },
//              { name: 'KEYS',       type: 'kv_namespace', namespace_id: '…' },
//              { name: 'DB',         type: 'd1', id: '…' },
//              { name: 'FEISHU_APP_SECRET', type: 'secret_text' },   ← 读不回明文,也不该读
//            ] } }

/// 当前生效版本的 id(取流量占比最高的那个;单版本部署时就是它)。
export function activeVersionId(deploymentsStatusJson) {
  let parsed;
  try { parsed = JSON.parse(String(deploymentsStatusJson ?? '')); } catch { return ''; }
  const versions = Array.isArray(parsed?.versions) ? parsed.versions : [];
  if (!versions.length) return '';
  const best = versions.reduce((acc, v) => ((v?.percentage ?? 0) > (acc?.percentage ?? -1) ? v : acc), null);
  return String(best?.version_id ?? '').trim();
}

/// 把版本 JSON 里的绑定拆成"可直接写进 wrangler.toml"的三类。
/// secret 类绑定**不会被读取**(值本来就取不到,也不该在本地留下)。
export function bindingsFromVersion(versionJson) {
  let parsed;
  try { parsed = JSON.parse(String(versionJson ?? '')); } catch { return { vars: {}, kv: {}, d1: {} }; }
  const bindings = parsed?.resources?.bindings;
  const out = { vars: {}, kv: {}, d1: {} };
  for (const b of Array.isArray(bindings) ? bindings : []) {
    if (!b || typeof b.name !== 'string') continue;
    if (b.type === 'plain_text' && typeof b.text === 'string') out.vars[b.name] = b.text;
    else if (b.type === 'kv_namespace' && typeof b.namespace_id === 'string') out.kv[b.name] = b.namespace_id;
    else if (b.type === 'd1' && typeof b.id === 'string') out.d1[b.name] = b.id;
  }
  return out;
}

/// 从 `wrangler whoami` 的输出里取出当前账号(邮箱 + 账号名/ID 列表)。
///
/// 恢复配置失败时最需要回答的问题是"我登的是哪个账号" —— 线上明明跑着一个后端,
/// 而这个账号里什么也没有,基本就是登错了账号。
export function parseWhoamiAccounts(text) {
  const raw = String(text ?? '');
  const email = /associated with the email\s+([^\s.]+(?:\.[^\s.]+)*)/.exec(raw)?.[1] ?? '';
  const accounts = [];
  for (const line of raw.split('\n')) {
    if (!line.includes('│')) continue;
    const cells = line.split('│').map((c) => c.trim()).filter((c) => c !== '');
    if (cells.length < 2) continue;
    const [name, id] = cells;
    if (/^-+$/.test(name) || /^Account Name$/i.test(name)) continue;
    if (!id || /^-+$/.test(id)) continue;
    accounts.push({ name, id });
  }
  return { email, accounts };
}
