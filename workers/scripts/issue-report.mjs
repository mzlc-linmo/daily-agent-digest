/// 配置值判定 + 签发提示。
///
/// 这里放的都是纯函数,便于单测。三件事容易出错:
///   · 仓库模板里的 `YOUR_…` / `REPLACE_WITH_…` 占位符不能被当成真实配置;
///   · `wrangler deploy` 的输出要能正确解析出成员的长期提交地址;
///   · 签发 Key 时要把地址一起给出去。

/// 判断一个值是否还是仓库模板里的占位符。
///
/// wrangler.toml 是随公开仓库分发的模板,里面的 token / 表 id / App ID 都是
/// `bascnREPLACE_WITH_YOUR_BASE_TOKEN`、`YOUR_SUBDOMAIN` 这类占位符。
/// 空值不算占位符 —— 那是"未配置",另有提示。
export function isPlaceholder(value) {
  const text = String(value ?? '').trim();
  if (!text) return false;
  return /YOUR_|REPLACE_WITH|[<>]/.test(text);
}

/// 找出仍然是占位符的配置项(传入 [标签, 值] 列表),用于状态页的整体告警。
export function placeholderLabels(entries) {
  return entries.filter(([, value]) => isPlaceholder(value)).map(([label]) => label);
}

/// 判断一个"提交地址"是否是真实可用的。
///
/// 占位符必须当作"没有地址":否则签发时会把一个根本不存在的地址当成
/// "本人要对接的提交地址"发出去。
export function knownSubmitUrl(raw) {
  const url = String(raw ?? '').trim();
  if (!url || isPlaceholder(url)) return '';
  return url;
}

/// 从 `wrangler deploy` 的输出里取出本次部署的 workers.dev 地址。
///
/// wrangler 在 "Deployed <worker> triggers" 之后逐行打印部署目标,例如:
///
///   Deployed daily-agent-digest-submit triggers (0.45 sec)
///     https://daily-agent-digest-submit.<账号的 workers.dev 子域>.workers.dev
///
/// 子域来自 Cloudflare 账号设置(不是登录时算出来的),worker 名来自 wrangler.toml。
/// 只认**以 worker 名开头**的地址:wrangler 里还有形如
/// `https://<版本号>-<worker>.<子域>.workers.dev` 的版本预览地址,它钉在某个版本上,
/// 不适合当成员长期使用的提交地址。
export function parseDeployedUrl(output, workerName) {
  const name = String(workerName ?? '').trim();
  if (!name) return '';
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`https://${escaped}\\.[a-z0-9.-]+\\.workers\\.dev`).exec(String(output ?? ''))?.[0] ?? '';
}

/// 决定"当前该用哪个提交地址":优先 wrangler.toml(部署时写入),其次环境变量。
///
/// 关键点:toml 里的占位符必须当作"没有",否则它会短路掉环境变量里的真实地址
/// (`knownSubmitUrl(toml) || knownSubmitUrl(env)` 的顺序不能反过来写成
/// `knownSubmitUrl(toml || env)` —— 那样占位符会把 env 挡掉)。
export function resolveSubmitUrl(tomlValue, envValue) {
  return knownSubmitUrl(tomlValue) || knownSubmitUrl(envValue);
}

/// 签发 Key 时给管理员看的提示行。
///
/// 抽成纯模块是为了能单测:Key 只显示一次,所以必须同时把**本人要对接的提交地址**
/// 一起给出 —— 只丢一串 Key 而不说填哪个地址,对方是没法上报的。
///
/// 返回 [样式, 文本] 列表,由 CLI 负责上色与打印。
/// 样式取值:ok / warn / dim / plain。
export function issueReportLines(label, issued, submitUrl) {
  const rows = [
    ['ok', `「${label}」的 Key(只显示这一次):`],
    ['plain', `    ${issued.key}`],
  ];
  if (submitUrl) {
    rows.push(['plain', `    提交地址:${submitUrl}`]);
    rows.push(['dim', '    本人把「提交地址」和这串 Key 填进托盘菜单「设置」,先点「测试连接」确认识别到本人,再点「保存」。']);
  } else {
    rows.push(['warn', '    wrangler.toml 里还没有 SUBMIT_URL:先部署一次再来签发,否则不知道该让本人填哪个地址。']);
  }
  rows.push(['dim', '    请立即发给本人;丢失在「员工与 Key」里轮换。']);
  if (issued.superseded?.length) {
    rows.push(['dim', `    已作废旧 Key:${issued.superseded.join(', ')}(一人一把)`]);
  }
  return rows;
}
