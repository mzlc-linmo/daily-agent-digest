// Cloudflare Worker 入口:HTTP + 定时任务。
import { handleRequest } from './handler.js';
import { processRequests } from './registry.js';
import * as feishu from './feishu.js';

export default {
  fetch(request, env, _ctx) {
    return handleRequest(request, env);
  },

  /// 定时任务(每 1 分钟):把「密钥申请」表里待处理的行自动签发成 Key,
  /// 并把明文 Key 写回该行 —— 成员填完表单就能在自己的行里看到 Key。
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      processRequests(env, feishu)
        .then((r) => console.log(`cron 处理申请:签发 ${r.issued} / 撤销 ${r.revoked} / 跳过 ${r.skipped}`))
        .catch((err) => console.error(`cron 处理申请失败:${err.message}`)),
    );
  },
};
