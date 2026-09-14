import json, os, subprocess, sys, tempfile, unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))
import daily_agent_digest as engine  # noqa: E402

# 跑子进程前必须屏蔽掉所有"会让测试打真实网络"的变量。
# DIGEST_API_KEY 曾经漏了:开发机 export 过它时,用例会带着真实 Key
# 向测试地址发真实 POST(既污染环境又泄露密钥)。
LLM_VARS = ("LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL", "DIGEST_SUBMIT_URL", "DIGEST_API_KEY", "DIGEST_MEMBER")


def command(home, name, payload, source_root=None, extra_env=None):
    env = {k: v for k, v in os.environ.items() if k not in LLM_VARS}
    env.update({"DIGEST_HOME": str(home), "DIGEST_DEBUG": "1"})
    if source_root is not None:
        env["DIGEST_SOURCE_ROOT"] = str(source_root)
    if extra_env:
        env.update(extra_env)
    p = subprocess.run([sys.executable, str(ROOT/'daily_agent_digest.py'), '--app-command', name],
                       input=json.dumps(payload), text=True, capture_output=True, env=env, check=False)
    assert p.returncode == 0, p.stderr + p.stdout
    return json.loads(p.stdout)


def today():
    """The engine's current report day, so these tests do not break at midnight."""
    return engine.dt.datetime.now(engine.TZ).date().isoformat()


def item(title, size=0, excluded=False, ident=None):
    return {"id": ident or title[:16].ljust(16, "x"), "title": title,
            "desc": ("完成了采集器重构并补充回归测试" * (size // 14 + 2))[:size],
            "status": "completed", "source_task_ids": ["codex/s1"], "excluded": excluded}


def pi_line(role, text, i=0, ts="2026-09-13T10:00:00+08:00"):
    """真实 pi 落盘形状:type=message + message.role + content 分片。"""
    return json.dumps({"type": "message", "id": f"m{i}", "timestamp": ts,
                       "message": {"role": role, "content": [{"type": "text", "text": text}]}},
                      ensure_ascii=False)


class StubSubmitService:
    """本地桩:验证客户端提交链路(请求头、载荷、响应处理)。"""

    def __init__(self, response):
        import http.server, threading
        payload = json.dumps(response).encode()
        captured = self.requests = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _handle(self):
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length)
                captured.append({
                    "path": self.path,
                    "headers": {k.lower(): v for k, v in self.headers.items()},
                    "body": json.loads(raw or b"{}"),
                })
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            do_GET = _handle
            do_POST = _handle

        self.server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.url = f"http://127.0.0.1:{self.port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


def no_llm_env():
    return {k: os.environ.pop(k, None) for k in ("LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL")}


def restore_env(saved):
    for key, value in saved.items():
        if value is not None:
            os.environ[key] = value


class CoreProtocolTests(unittest.TestCase):
    def test_clear_and_settings_are_private_and_atomic(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d); state = command(home, 'clear', {'date':'2099-01-01'})
            self.assertEqual(state['report_status'], 'generating')
            command(home, 'save-settings', {'base_url':'https://example.invalid/v1', 'model':'test-model', 'api_key':'secret'})
            self.assertEqual((home/'.env').stat().st_mode & 0o777, 0o600)
            self.assertEqual(command(home, 'settings', {})['model'], 'test-model')
            self.assertFalse((home/'state.json.tmp').exists())


class ReportShapeTests(unittest.TestCase):
    """The report is a list of independent work items (title + desc), capped at
    1000 characters, and no work item is ever dropped to fit."""

    def total(self, items):
        return sum(engine.char_count(i['title']) + engine.char_count(i['desc']) for i in items)

    def test_char_count_ignores_whitespace(self):
        self.assertEqual(engine.char_count("  a b\n\tc  "), 3)
        self.assertEqual(engine.char_count("日报 摘要"), 4)
        self.assertEqual(engine.char_count(None), 0)

    def test_three_items_can_use_the_full_body_range(self):
        items, total = engine.fit_report([item(f"主题{i}", 400) for i in range(3)])
        self.assertLessEqual(total, engine.REPORT_CHAR_LIMIT)
        self.assertEqual(len(items), 3)
        for entry in items:
            body = engine.char_count(entry['desc'])
            self.assertGreaterEqual(body, engine.ITEM_CHAR_MIN)
            self.assertLessEqual(body, engine.ITEM_CHAR_MAX)

    def test_many_items_are_compressed_and_none_are_dropped(self):
        items, total = engine.fit_report([item(f"主题{i}", 400) for i in range(20)])
        self.assertEqual(len(items), 20, "the report must never drop a work item")
        self.assertLessEqual(total, engine.REPORT_CHAR_LIMIT)

    def test_item_chars_field_matches_title_plus_body(self):
        items, _ = engine.fit_report([item("标题", 120)])
        self.assertEqual(items[0]['chars'], engine.char_count("标题") + engine.char_count(items[0]['desc']))

    def test_long_title_is_clamped(self):
        items, _ = engine.fit_report([{"title": "很长" * 60, "desc": "内容"}])
        self.assertLessEqual(engine.char_count(items[0]['title']), engine.TITLE_CHAR_MAX)

    def test_empty_body_is_allowed_no_minimum(self):
        items, total = engine.fit_report([item(f"主题{i}", 0) for i in range(3)])
        self.assertEqual([engine.char_count(i['desc']) for i in items], [0, 0, 0])
        self.assertLessEqual(total, engine.REPORT_CHAR_LIMIT)

    def test_total_never_exceeds_limit_even_with_oversized_input(self):
        items, total = engine.fit_report([item(f"主题{i}", 1200) for i in range(4)])
        self.assertLessEqual(total, engine.REPORT_CHAR_LIMIT)
        self.assertEqual(len(items), 4)


class ExclusionIsArrayFilterTests(unittest.TestCase):
    """排除一项 = 从数组里去掉一项:不调用 LLM,描述文字原样保留,立即可逆。"""

    def state(self):
        return {"schema_version": "1.2", "date": today(),
                "work_items": [item("采集器重构", 150, ident="a"*16),
                               item("CI 签名修复", 150, ident="b"*16)],
                "report_chars": 0, "included_count": 0, "excluded_count": 0, "last_error": None}

    def test_report_chars_counts_only_included_items(self):
        state = self.state()
        state['work_items'][1]['excluded'] = True
        engine.recount_report(state)
        self.assertEqual(state['included_count'], 1)
        self.assertEqual(state['excluded_count'], 1)
        self.assertEqual(state['report_chars'],
                         engine.char_count("采集器重构") + engine.char_count(state['work_items'][0]['desc']))

    def test_excluding_needs_no_llm_and_leaves_descriptions_untouched(self):
        saved = no_llm_env()
        try:
            with tempfile.TemporaryDirectory() as d:
                home = Path(d)
                before = self.state()
                (home / "state.json").write_text(json.dumps(before, ensure_ascii=False), encoding="utf-8")
                result = command(home, "exclude", {"date": today(), "id": "b" * 16})
        finally:
            restore_env(saved)
        self.assertIsNone(result.get("last_error"), "排除不应依赖 LLM,也不应报错")
        self.assertNotIn("summary", result)
        self.assertEqual([i["id"] for i in result["work_items"] if i["excluded"]], ["b" * 16])
        for entry in result["work_items"]:
            expected = next(i for i in before["work_items"] if i["id"] == entry["id"])
            self.assertEqual(entry["desc"], expected["desc"], "排除不应改动任何描述文字")

    def test_exclude_then_restore_round_trips(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d)
            seed = self.state()
            (home / "state.json").write_text(json.dumps(seed, ensure_ascii=False), encoding="utf-8")
            excluded = command(home, "exclude", {"date": today(), "id": "a"*16})
            self.assertEqual(excluded["included_count"], 1)
            self.assertEqual(excluded["excluded_count"], 1)
            self.assertEqual(excluded["report_chars"],
                             engine.char_count("CI 签名修复") + engine.char_count(seed["work_items"][1]["desc"]))
            restored = command(home, "restore", {"date": today(), "id": "a"*16})
            self.assertEqual(restored["included_count"], 2)
            self.assertEqual(restored["excluded_count"], 0)

    def test_unknown_id_is_rejected_and_changes_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d)
            (home / "state.json").write_text(json.dumps(self.state(), ensure_ascii=False), encoding="utf-8")
            p = subprocess.run([sys.executable, str(ROOT/'daily_agent_digest.py'), '--app-command', 'exclude'],
                               input=json.dumps({"date": today(), "id": "does-not-exist"}), text=True, capture_output=True,
                               env={**os.environ, "DIGEST_HOME": str(home)}, check=False)
            self.assertEqual(p.returncode, 1)
            self.assertIn("unknown work item id", p.stdout)
            self.assertEqual(json.loads((home / "state.json").read_text(encoding="utf-8"))["excluded_count"], 0)

    def test_exclusions_survive_regeneration(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d) / "home"; source = Path(d) / "source"
            sessions = source / ".pi/agent/sessions"; sessions.mkdir(parents=True)
            lines = [pi_line("user", "重构采集器并补充测试。", 0, "2026-09-12T10:00:00+08:00")]
            (sessions / "session-a.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")
            first = command(home, 'generate', {'date': '2026-09-12', 'source_root': str(source)})
            target = first['work_items'][0]['id']
            command(home, 'exclude', {'date': '2026-09-12', 'id': target})
            again = command(home, 'generate', {'date': '2026-09-12', 'source_root': str(source)})
            self.assertEqual([i['id'] for i in again['work_items'] if i['excluded']], [target])


class GenerateTests(unittest.TestCase):
    def test_generate_returns_items_with_titles_and_bodies_within_the_limit(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d) / "home"; source = Path(d) / "source"
            sessions = source / ".pi/agent/sessions"; sessions.mkdir(parents=True)
            lines = []
            for i in range(40):
                lines.append(pi_line("user" if i % 2 == 0 else "assistant",
                                     f"第{i}条工作记录：重构采集器并补充测试。" * 5, i,
                                     "2026-09-12T10:%02d:00+08:00" % (i % 60)))
            (sessions / "session-a.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")
            state = command(home, 'generate', {'date': '2026-09-12', 'source_root': str(source)})
            self.assertEqual(state['report_status'], 'ready', state.get('last_error'))
            self.assertTrue(state['work_items'])
            self.assertNotIn('summary', state, "报告就是工作项列表,没有单独的叙述字段")
            for entry in state['work_items']:
                self.assertTrue(entry['title'])
                self.assertIn('desc', entry)
            total = sum(engine.char_count(i['title']) + engine.char_count(i['desc'])
                        for i in state['work_items'])
            self.assertEqual(total, state['report_chars'])
            self.assertLessEqual(total, engine.REPORT_CHAR_LIMIT)
            cleared = command(home, 'clear', {'date': '2026-09-12'})
            self.assertEqual(cleared['report_chars'], 0)
            self.assertEqual(cleared['work_items'], [])


class ExtractionTests(unittest.TestCase):
    """采集阶段只抽出「用户提示词」「AI 最终文本」「交付物」,过程一律不进汇总。

    回归的缺陷有两个:
    ① 采集器先把每条记录硬截断到 4000 字符再处理,dsh 65 条 assistant/message 里
       54 条被切成半个 JSON,结构化抽取根本拿不到最终文本;
    ② 用 'automation_u' 之类子串匹配整条文本去排除自动化,把提到该词的 8 条真实
       叙述(32,000 字符)误删。
    """

    def test_codex_extracts_only_prompt_and_result(self):
        prompt = {"type": "userMessage", "content": [{"type": "text", "text": "重构采集器并补测试"}]}
        result = {"type": "agentMessage", "text": "已统一窗口过滤并补了测试"}
        self.assertEqual(engine.extract_codex("userMessage", prompt), ("prompt", "重构采集器并补测试"))
        self.assertEqual(engine.extract_codex("agentMessage", result), ("result", "已统一窗口过滤并补了测试"))
        for kind in ("reasoning", "functionCallOutput", "commandExecution", "mcpToolCall", "contextCompaction"):
            self.assertEqual(engine.extract_codex(kind, {"text": "过程"}), (None, None), kind)

    def test_dsh_extracts_text_parts_and_drops_process(self):
        user = {"type": "user/message", "data": {"content": [{"type": "text", "text": "排查 CI 公证"}]}}
        assistant = {"type": "assistant/message", "data": {"message": {"role": "assistant", "content": [
            {"type": "reasoning", "text": "内部推理不应进入汇总"},
            {"type": "tool-call", "name": "bash", "arguments": "{}"},
            {"type": "text", "text": "定位到 notarytool 超时后重复提交"},
        ]}}}
        deliverable = {"type": "deliverables/presented", "data": {"files": [
            {"path": "docs/requirements.md", "description": "补充预算与验收"}]}}
        self.assertEqual(engine.extract_dsh(user), ("prompt", "排查 CI 公证"))
        role, text = engine.extract_dsh(assistant)
        self.assertEqual(role, "result")
        self.assertIn("notarytool 超时", text)
        self.assertNotIn("内部推理", text)
        self.assertNotIn("bash", text)
        role, text = engine.extract_dsh(deliverable)
        self.assertEqual(role, "deliverable")
        self.assertIn("docs/requirements.md", text)
        for kind in ("tool/call", "tool/result", "step/start", "step/end", "turn/start", "turn/end"):
            self.assertEqual(engine.extract_dsh({"type": kind, "data": {}}), (None, None), kind)

    def test_pi_extracts_by_role_and_ignores_thinking(self):
        user = {"type": "message", "message": {"role": "user", "content": [{"type": "text", "text": "补归档读取"}]}}
        assistant = {"type": "message", "message": {"role": "assistant", "content": [
            {"type": "thinking", "thinking": "内部思考"},
            {"type": "toolCall", "name": "bash", "arguments": "{}"},
            {"type": "text", "text": "已补上 archived_sessions 兼容读取"},
        ]}}
        tool = {"type": "message", "message": {"role": "toolResult", "content": [{"type": "text", "text": "total 440"}]}}
        self.assertEqual(engine.extract_pi(user), ("prompt", "补归档读取"))
        role, text = engine.extract_pi(assistant)
        self.assertEqual(role, "result")
        self.assertIn("archived_sessions", text)
        self.assertNotIn("内部思考", text)
        self.assertEqual(engine.extract_pi(tool), (None, None))

    def test_long_records_are_extracted_before_being_capped(self):
        """先抽取再截断:一条远超 4000 字符的记录,其正文仍应完整取到(上限内)。"""
        body = "长叙述" * 3000
        record = json.dumps({"type": "message", "timestamp": "2026-09-13T10:00:00+08:00",
                             "message": {"role": "assistant", "content": [{"type": "text", "text": body}]}},
                            ensure_ascii=False)
        self.assertGreater(len(record), 4000)
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "s.jsonl"
            path.write_text(record + "\n", encoding="utf-8")
            stats = engine.new_stats(); out = []
            engine.read_jsonl(path, "pi", *engine.day_window("2026-09-13"), stats, out, False)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["role"], "result")
        self.assertGreater(len(out[0]["text"]), 4000 - 1)
        self.assertEqual(len(out[0]["text"]), engine.MESSAGE_CHAR_MAX)
        self.assertTrue(out[0]["truncated"])

    def test_mentions_of_automation_are_not_treated_as_automation(self):
        """旧的子串规则会误删这些记录;现在只看结构,提示词与最终文本一律保留。"""
        events = [
            {"provider": "deepseek-harness", "role": "result", "kind": "assistant/message",
             "text": "查清了 automation_update 这个工具的行为,它是定时任务,不参与汇总", "timestamp": "t"},
            {"provider": "codex", "role": "prompt", "kind": "userMessage",
             "text": "自动化规则里的 automation_u 前缀是怎么来的?", "timestamp": "t"},
        ]
        context, stats = engine.build_context(events)
        self.assertIn("automation_update", context)
        self.assertIn("automation_u 前缀", context)
        self.assertEqual(stats["sent_by_role"]["prompt"], 1)
        self.assertEqual(stats["sent_by_role"]["result"], 1)


class ContextSelectionTests(unittest.TestCase):
    """上下文只装提示词/最终文本/交付物,并在来源之间轮转、守住预算。"""

    def ev(self, provider, role, text, ts="2026-09-13T10:00:00+08:00"):
        return {"provider": provider, "session_id": provider + "-s", "item_id": text[:8],
                "timestamp": ts, "kind": "message", "role": role, "text": text,
                "dedupe_key": f"{provider}|{text[:8]}"}

    def test_prompts_are_kept_before_results_and_deliverables(self):
        events = [self.ev("codex", "result", "结果" + "x" * 500) for _ in range(10)]
        events.append(self.ev("codex", "prompt", "这是人的真实意图,必须优先保留"))
        context, stats = engine.build_context(events, limit=1200)
        self.assertIn("这是人的真实意图", context)
        self.assertEqual(stats["sent_by_role"]["prompt"], 1)

    def test_one_provider_cannot_starve_the_other(self):
        big = [self.ev("codex", "result", f"codex 大量结果 {i} " + "x" * 850) for i in range(60)]
        small = [self.ev("deepseek-harness", "result", f"dsh 真实工作叙述 {i} " + "y" * 300) for i in range(10)]
        context, stats = engine.build_context(big + small, limit=20000)
        self.assertGreater(stats["sent_by_provider"].get("deepseek-harness", 0), 0)
        self.assertIn("dsh 真实工作叙述", context)

    def test_budget_is_respected_and_omissions_are_reported(self):
        events = [self.ev("codex", "prompt", f"提示 {i} " + "x" * 400) for i in range(200)]
        context, stats = engine.build_context(events, limit=5000)
        self.assertLessEqual(len(context), 5000)
        self.assertEqual(stats["sent"] + sum(stats["omitted_by_provider"].values()), stats["unique"])
        self.assertIn("因预算省略", engine.context_note(stats))

    def test_duplicates_are_collapsed(self):
        events = [self.ev("codex", "result", "完全相同的一句话") for _ in range(5)]
        _, stats = engine.build_context(events)
        self.assertEqual(stats["unique"], 1)

    def test_default_budget_matches_the_documented_limit(self):
        self.assertEqual(engine.CONTEXT_CHAR_LIMIT, 90000)


class CollectionPipelineTests(unittest.TestCase):
    """端到端:采集只留提示词/结果/交付物,过程记录默认被丢弃,可用开关回退。"""

    def build_source(self, root):
        sessions = root / ".pi/agent/sessions"; sessions.mkdir(parents=True)
        lines = [pi_line("user", "重构采集器并补充测试", 0, "2026-09-13T10:00:00+08:00"),
                 pi_line("assistant", "已完成重构并新增 23 项测试", 1, "2026-09-13T10:05:00+08:00"),
                 pi_line("toolResult", "total 440", 2, "2026-09-13T10:06:00+08:00")]
        (sessions / "s.jsonl").write_text("\n".join(lines) + "\n", encoding="utf-8")

    def test_collect_keeps_only_prompt_and_result(self):
        with tempfile.TemporaryDirectory() as d:
            source = Path(d) / "src"; self.build_source(source)
            events, stats = engine.collect(source, *engine.day_window("2026-09-13"))
        roles = sorted(e["role"] for e in events)
        self.assertEqual(roles, ["prompt", "result"])
        self.assertEqual(stats["pi"]["process"], 1)
        self.assertEqual(stats["pi"]["prompt"], 1)

    def test_process_records_can_be_re_enabled_with_the_escape_hatch(self):
        saved = os.environ.get("DIGEST_CONTEXT_INCLUDE_PROCESS")
        os.environ["DIGEST_CONTEXT_INCLUDE_PROCESS"] = "1"
        try:
            with tempfile.TemporaryDirectory() as d:
                source = Path(d) / "src"; self.build_source(source)
                events, stats = engine.collect(source, *engine.day_window("2026-09-13"))
        finally:
            if saved is None: os.environ.pop("DIGEST_CONTEXT_INCLUDE_PROCESS", None)
            else: os.environ["DIGEST_CONTEXT_INCLUDE_PROCESS"] = saved
        self.assertIn("process", [e["role"] for e in events])


class SubmitNeverFakesSuccessTests(unittest.TestCase):
    """D-1:未配置上报通道或上报失败时,绝不能把日报标记成已上报。"""

    def seed(self, home):
        state = {"schema_version": "1.2", "date": today(), "report_status": "ready",
                 "work_items": [item("采集器重构", 150, ident="a"*16)],
                 "report_chars": 0, "included_count": 0, "excluded_count": 0,
                 "submit_status": None, "submit_error": None, "last_error": None}
        engine.recount_report(state)
        (Path(home) / "state.json").write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")

    def test_submit_without_a_webhook_is_not_reported_as_submitted(self):
        saved = {k: os.environ.pop(k, None) for k in ("DIGEST_SUBMIT_URL",)}
        try:
            with tempfile.TemporaryDirectory() as d:
                self.seed(d)
                result = command(Path(d), "submit", {"date": today()})
                stored = json.loads((Path(d) / "state.json").read_text(encoding="utf-8"))
        finally:
            for key, value in saved.items():
                if value is not None: os.environ[key] = value
        self.assertNotEqual(result["report_status"], "submitted", "未配置通道时不得标记为已上报")
        self.assertEqual(result["report_status"], "ready")
        self.assertEqual(result["submit_status"], "not_configured")
        self.assertTrue(result["submit_error"])
        self.assertEqual(stored["submit_status"], "not_configured")
        self.assertNotIn("submitted_count", stored)

    def test_excluding_after_submit_makes_the_report_pending_again(self):
        # 排除改变了内容,上一次上报就失效了。否则 submit() 会因 report_status=='submitted'
        # 直接早退,服务端永远拿不到更新,界面却仍显示"已上报"。
        server = StubSubmitService({"mode": "created", "submitted_at": "2026-09-13T18:00:00+08:00"})
        try:
            with tempfile.TemporaryDirectory() as d:
                home = Path(d)
                self.seed(home)
                date = today()
                submitted = command(home, "submit", {"date": date},
                                    extra_env={"DIGEST_SUBMIT_URL": server.url, "DIGEST_API_KEY": "dag_k1_secret"})
                self.assertEqual(submitted["report_status"], "submitted")
                item_id = submitted["work_items"][0]["id"]
                after = command(home, "exclude", {"date": date, "id": item_id})
        finally:
            server.stop()
        self.assertEqual(after["report_status"], "ready", "排除后必须重新变为待上报")
        self.assertEqual(after["submit_status"], "stale")
        self.assertTrue(after["work_items"][0]["excluded"])

    def test_non_object_submit_response_is_recorded_as_failure(self):
        # 服务端返回合法 JSON 但不是对象时,以前会在 body.get 上抛 AttributeError,
        # submit_status 完全没落盘,界面无法区分"未提交"和"提交失败"。
        server = StubSubmitService(["not", "an", "object"])
        try:
            with tempfile.TemporaryDirectory() as d:
                home = Path(d)
                self.seed(home)
                result = command(home, "submit", {"date": today()},
                                 extra_env={"DIGEST_SUBMIT_URL": server.url, "DIGEST_API_KEY": "dag_k1_secret"})
        finally:
            server.stop()
        self.assertNotEqual(result["report_status"], "submitted")
        self.assertEqual(result["submit_status"], "failed")
        self.assertTrue(result["submit_error"])

    def test_a_failing_service_is_not_reported_as_submitted(self):
        with tempfile.TemporaryDirectory() as d:
            self.seed(d)
            # 127.0.0.1:1 上没有服务,连接必然失败
            result = command(Path(d), "submit", {"date": today()},
                             extra_env={"DIGEST_SUBMIT_URL": "http://127.0.0.1:1",
                                        "DIGEST_API_KEY": "dag_k1_secret"})
        self.assertNotEqual(result["report_status"], "submitted")
        self.assertEqual(result["submit_status"], "failed")
        self.assertTrue(result["submit_error"])

    def test_missing_api_key_is_not_configured_rather_than_failed(self):
        with tempfile.TemporaryDirectory() as d:
            self.seed(d)
            result = command(Path(d), "submit", {"date": today()},
                             extra_env={"DIGEST_SUBMIT_URL": "https://digest.example.com"})
            stored = json.loads((Path(d) / "state.json").read_text(encoding="utf-8"))
        self.assertEqual(result["submit_status"], "not_configured")
        self.assertNotEqual(result["report_status"], "submitted")
        self.assertNotIn("secret-value", json.dumps(stored), "状态里绝不能出现密钥内容")

    def test_a_successful_submission_marks_submitted_with_the_returned_mode(self):
        server = StubSubmitService({"mode": "created", "submitted_at": "2026-09-13T18:00:00+08:00"})
        try:
            with tempfile.TemporaryDirectory() as d:
                self.seed(d)
                result = command(Path(d), "submit", {"date": today()},
                                 extra_env={"DIGEST_SUBMIT_URL": server.url, "DIGEST_API_KEY": "dag_k1_secret"})
            request = server.requests[0]
        finally:
            server.stop()
        self.assertEqual(result["report_status"], "submitted")
        self.assertEqual(result["submit_status"], "submitted")
        self.assertEqual(result["submit_mode"], "created")
        self.assertEqual(request["headers"]["authorization"], "Bearer dag_k1_secret")
        # Cloudflare 会拦 Python-urllib 的默认 UA(1010),必须带自己的标识
        self.assertEqual(request["headers"]["user-agent"], engine.USER_AGENT)
        self.assertIn("DailyAgentDigest/", request["headers"]["user-agent"])
        self.assertTrue(request["headers"]["idempotency-key"])
        self.assertEqual(request["body"]["work_items"][0]["title"], "采集器重构")
        self.assertEqual(request["body"]["release_version"], engine.RELEASE_VERSION)

    def test_check_submit_validates_the_key_against_the_service(self):
        server = StubSubmitService({"member": "张三", "member_id": "zhangsan"})
        try:
            with tempfile.TemporaryDirectory() as d:
                home = Path(d)
                result = command(home, "check-submit", {},
                                 extra_env={"DIGEST_SUBMIT_URL": server.url, "DIGEST_API_KEY": "dag_k1_secret"})
        finally:
            server.stop()
        self.assertEqual(result["member"], "张三")

    def test_check_submit_without_configuration_reports_an_error(self):
        saved = {k: os.environ.pop(k, None) for k in ("DIGEST_SUBMIT_URL", "DIGEST_API_KEY")}
        try:
            with tempfile.TemporaryDirectory() as d:
                p = subprocess.run([sys.executable, str(ROOT/'daily_agent_digest.py'), '--app-command', 'check-submit'],
                                   input="{}", text=True, capture_output=True,
                                   env={**os.environ, "DIGEST_HOME": d}, check=False)
        finally:
            for key, value in saved.items():
                if value is not None: os.environ[key] = value
        self.assertEqual(p.returncode, 1)
        self.assertIn("未配置提交地址", p.stdout)

    def test_tick_after_18_does_not_mark_submitted_without_a_webhook(self):
        saved = {k: os.environ.pop(k, None) for k in ("DIGEST_SUBMIT_URL",)}
        try:
            with tempfile.TemporaryDirectory() as d:
                self.seed(d)
                result = command(Path(d), "tick", {"date": today()},
                                 extra_env={"DIGEST_SOURCE_ROOT": str(Path(d) / "empty-source")})
        finally:
            for key, value in saved.items():
                if value is not None: os.environ[key] = value
        self.assertNotEqual(result["report_status"], "submitted")


if __name__ == '__main__': unittest.main()
