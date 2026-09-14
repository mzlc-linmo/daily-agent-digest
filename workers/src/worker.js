// Cloudflare Worker 入口:HTTP + 定时任务。
import { handleRequest } from './handler.js';
import { pruneLogs } from './logs.js';

export default {
  fetch(request, env, _ctx) {
    return handleRequest(request, env);
  },

  /// 定时任务(每小时第 0 分钟):清理过期审计日志。
  /// 成员自助申请 Key 的流程已取消,签发改为管理员用本机 CLI 完成,因此这里不再轮询飞书表。
  async scheduled(event, env, ctx) {
    const minute = new Date(event?.scheduledTime ?? Date.now()).getUTCMinutes();
    if (minute !== 0) return;
    ctx.waitUntil(
      pruneLogs(env, 180)
        .then((n) => { if (n) console.log(`cron 清理审计日志:${n} 行`); })
        .catch((err) => console.error(`cron 清理日志失败:${err.message}`)),
    );
  },
};
