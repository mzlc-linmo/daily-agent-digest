// 本地运行 Worker 逻辑(开发/验证用,不经过 Cloudflare)。
//
//   node workers/scripts/local-server.mjs           # 端口 8787
//   PORT=9000 node workers/scripts/local-server.mjs
//
// 需要的环境变量:
//   FEISHU_APP_ID / FEISHU_APP_SECRET / BITABLE_APP_TOKEN
//   BITABLE_TABLE_ID(先留空跑 /admin/bootstrap,拿到后再填)
//   ADMIN_TOKEN / API_KEYS
//
// 密钥建议从钥匙串读取后导出,不要写进文件:
//   export FEISHU_APP_SECRET="$(security find-generic-password -s zentao.mzlc.me -a feishu-app-secret -w)"

import http from 'node:http';
import { handleRequest } from '../src/handler.js';

const port = Number(process.env.PORT ?? 8787);

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://127.0.0.1:${port}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body,
  });
  const response = await handleRequest(request, process.env);
  const text = await response.text();
  res.writeHead(response.status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`local submit service on http://127.0.0.1:${port} (table=${process.env.BITABLE_TABLE_ID || '(未设置)'})`);
});
