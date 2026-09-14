/// 判断一个"提交地址"是否是真实可用的。
///
/// wrangler.toml 是随仓库分发的模板,里面的 SUBMIT_URL 是
/// `https://daily-agent-digest-submit.YOUR_SUBDOMAIN.workers.dev` 这样的占位符;
/// 部署成功后 cmdDeploy 才会把它改写成真实地址。若不识别占位符,签发时就会把
/// 一个根本不存在的地址当成"本人要对接的提交地址"发出去。
export function knownSubmitUrl(raw) {
  const url = String(raw ?? '').trim();
  if (!url) return '';
  if (/YOUR_|REPLACE_WITH|[<>]/.test(url)) return '';
  return url;
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
