// Cloudflare Worker 入口:HTTP + 定时任务。
import { handleRequest } from './handler.js';
import { processRequests } from './registry.js';
import { pruneLogs } from './logs.js';
import * as feishu from './feishu.js';

export default {
  fetch(request, env, _ctx) {
    return handleRequest(request, env);
  },

  /// 定时任务(每 1 分钟):
  ///   ① 把「密钥申请」表里待处理的行自动签发成 Key,并把明文写回该行;
  ///   ② 每小时清理一次过期审计日志。
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      processRequests(env, feishu)
        .then((r) => console.log(`cron 处理申请:签发 ${r.issued} / 撤销 ${r.revoked} / 跳过 ${r.skipped}`))
        .catch((err) => console.error(`cron 处理申请失败:${err.message}`)),
    );
    const minute = new Date(event?.scheduledTime ?? Date.now()).getUTCMinutes();
    if (minute === 0) {
      ctx.waitUntil(
        pruneLogs(env, 180)
          .then((n) => { if (n) console.log(`cron 清理审计日志:${n} 行`); })
          .catch((err) => console.error(`cron 清理日志失败:${err.message}`)),
      );
    }
  },
};
