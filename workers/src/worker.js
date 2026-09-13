// Cloudflare Worker 入口。
import { handleRequest } from './handler.js';

export default {
  fetch(request, env, _ctx) {
    return handleRequest(request, env);
  },
};
