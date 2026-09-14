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
