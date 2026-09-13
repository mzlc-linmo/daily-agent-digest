#!/usr/bin/env python3
"""Minimal OpenAI-compatible mock endpoint for the local dev harness.

Lets the full generation path (collect -> compact -> single LLM pass -> state)
run deterministically, offline, and without spending API credits.

Modes:
    ok         canned thematic work items with realistic 100-300 character bodies
    verbose    deliberately over-long titles and bodies, to exercise the local clamp
    malformed  HTTP 200 with a non-JSON body (exercises the fallback path)
    error500   HTTP 500 (exercises the error path)
    hang       sleeps, to exercise client timeouts (use with a short timeout)
"""
import argparse
import json
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CODEX_SESSION = "01a09339-fixture-codex-0001"
PI_SESSION = "pi-fixture-0001"
DSH_SESSION = "dsh-fixture-0001"

THEMATIC_REPORT = {
    "work_items": [
        {
            "title": "重构日报采集器并补充跨源去重",
            "desc": (
                "梳理 Codex 会话表结构，确认 thread_items.created_at_ms 可以直接用于按日窗口过滤，"
                "避免此前按文件修改时间判断导致跨天记录被误算。随后把三个数据源的窗口判断抽成同一个 in_window，"
                "统一处理毫秒与秒级时间戳以及带 Z 的 ISO8601，消除了 DeepSeek Harness 记录被漏采的问题。"
                "在本地补齐跨 provider 去重，同一句话在 Codex 与 Pi 中同时出现时只保留一条摘录，"
                "实测把当天 1674 条事件压缩到 500 条以内，为单次 LLM 请求腾出预算。最后给 pi 的 jsonl 采集"
                "补上 archived_sessions 兼容读取，并新增采集端到端测试，确认重复摘录不会进入最终日报。"
            ),
            "status": "completed",
            "source_task_ids": [f"codex/{CODEX_SESSION}", f"pi/{PI_SESSION}"],
        },
        {
            "title": "确定日报字数契约与渲染方案",
            "desc": (
                "把日报形态从一段自由叙述改成结构化的工作项数组：每项由标题与正文组成，"
                "整份日报（所有标题 + 所有正文）不超过 1000 字，单项正文目标 100-300 字。"
                "关键设计是把「排除」实现为数组过滤而不是重新生成——排除一项就少一项标题与正文，"
                "不调用 LLM、瞬时生效、完全可逆。实现上不依赖模型自律：解析响应后本地二次裁剪，"
                "按项数均分剩余预算、优先在句号处收尾、超长标题裁到 30 字，并记录 report_chars 便于核对。"
            ),
            "status": "in_progress",
            "source_task_ids": [f"codex/{CODEX_SESSION}"],
        },
        {
            "title": "修复 CI 签名与 Apple 公证流程",
            "desc": (
                "排查 notarytool 提交超时：原先超时后直接重试导致同一构建重复提交，"
                "改为保留 submission id 并轮询状态，避免被 Apple 判定为重复提交。"
                "修复签名顺序问题，先签内部嵌入式库再签外层二进制，最后用 codesign --verify --deep --strict 校验整包，"
                "并在流水线中加入签名与公证产物的断言，确保发布资产与 CI 记录一致。"
            ),
            "status": "completed",
            "source_task_ids": [f"deepseek-harness/{DSH_SESSION}"],
        },
    ],
    "decisions": ["日报改为结构化工作项数组，排除即数组过滤，不重新生成"],
    "blockers": [],
    "next_steps": ["修掉 submit 未配置上报地址仍标记为成功的问题"],
}

VERBOSE_FILLER = "这一段是故意写长的内容，用来验证本地裁剪是否生效，确保整份日报不会超过一千字的上限，同时保证工作项本身不会被删除。"


class Handler(BaseHTTPRequestHandler):
    mode = "ok"

    def log_message(self, fmt, *args):  # keep the harness output tidy
        return

    def _send(self, code, payload, content_type="application/json"):
        body = payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            self._send(200, {"status": "ok", "mode": self.mode})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        try:
            request = json.loads(raw)
        except json.JSONDecodeError:
            request = {}
        messages = request.get("messages") or []
        user_chars = len(messages[-1].get("content", "")) if messages else 0
        model = request.get("model", "")
        print(f"[mock-llm] mode={self.mode} model={model} messages={len(messages)} user_chars={user_chars}", flush=True)

        if self.mode == "hang":
            time.sleep(600)
            return
        if self.mode == "error500":
            self._send(500, {"error": {"message": "mock upstream failure"}})
            return
        if self.mode == "malformed":
            self._send(200, {"choices": [{"message": {"role": "assistant", "content": "抱歉，我无法按要求返回 JSON。"}}]})
            return

        report = dict(THEMATIC_REPORT)
        report["work_items"] = [dict(i) for i in THEMATIC_REPORT["work_items"]]
        report["work_items"][0]["desc"] += f"（mock 收到 {user_chars} 字符上下文）"
        if self.mode == "verbose":
            report["work_items"] = [dict(i, title=i["title"] * 3, desc=i["desc"] * 3)
                                    for i in report["work_items"]]
        content = json.dumps(report, ensure_ascii=False)
        self._send(200, {"id": "mock-1", "object": "chat.completion", "model": model or "dev-mock",
                         "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}]})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--mode", default="ok", choices=["ok", "verbose", "malformed", "error500", "hang"])
    args = parser.parse_args()
    Handler.mode = args.mode
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"MOCK_LLM_READY http://127.0.0.1:{args.port}/v1 mode={args.mode}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        print("[mock-llm] stopped", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
