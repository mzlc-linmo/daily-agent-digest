#!/usr/bin/env python3
"""Generate an isolated fixture source tree for local development.

Creates codex / pi / deepseek-harness session data under <root> using the same
record shapes the clients actually write, so the dev engine exercises the real
extraction path (prompts / final results / deliverables kept, process dropped).

Usage:
    python3 scripts/dev_fixtures.py <root> [--date YYYY-MM-DD] [--clean]
"""
import argparse
import datetime as dt
import json
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

TZ = dt.timezone(dt.timedelta(hours=8))

CODEX_SESSION = "01a09339-fixture-codex-0001"
PI_SESSION = "pi-fixture-0001"
DSH_SESSION = "dsh-fixture-0001"

# (hour, minute, text) —— 人的提示词,应当进入上下文
CODEX_PROMPTS = [
    (9, 5, "帮我重构日报采集器的时间窗口过滤,三个数据源的实现要统一。"),
    (11, 40, "确认一下日报的 token 预算该怎么定,写进需求文档。"),
    (16, 30, "午饭想吃什么?顺便看看周末要不要去露营。"),
]
# (hour, minute, text) —— AI 的最终结果,应当进入上下文
CODEX_RESULTS = [
    (9, 26, "已把三个数据源的窗口过滤抽成统一的 in_window,统一处理毫秒与秒级时间戳,避免了 dsh 记录被漏采。"),
    (11, 55, "预算定为:单条摘录 900 字符、单次请求 90000 字符、工作项上限 20 条,并写入了 docs/requirements.md。"),
]
# 过程记录:结构化抽取必须丢弃
CODEX_PROCESS = [
    (9, 10, "functionCallOutput", {"name": "automation_update", "namespace": "codex_app", "output": "automation run ok"}),
    (9, 12, "reasoning", {"summary": ["Checking the collector code path"]}),
    (9, 18, "commandExecution", {"command": "python3 -m unittest discover -s tests", "output": "OK"}),
    (9, 40, "functionCallOutput", {"name": "automation_update", "namespace": "codex_app", "output": "automation run ok"}),
]
CODEX_ARCHIVE = [
    (17, 5, "把当天的采集结果与 state.json 做了一次对账,确认排除项在重新生成后仍然保留。"),
]

PI_EVENTS = [
    (10, 3, "user", "给 pi 的 jsonl 采集补上 archived_sessions 的兼容读取。"),
    (10, 20, "assistant", "已补上 archived_sessions 兼容读取,历史归档不再漏采。"),
    (10, 25, "toolResult", "total 440\ndrwxr-xr-x  12 user  staff  384 ."),
    (15, 20, "user", "把时区固定为 UTC+8 的影响写进需求文档的局限性说明。"),
    (15, 40, "assistant", "已把 TZ 固定为 UTC+8 的影响写入需求文档局限性说明,提示跨时区可能出现日期归属偏移。"),
]

DSH_EVENTS = [
    (13, 15, "user/message", "排查一下 CI 公证为什么失败。"),
    (13, 20, "assistant/message", "我先看 notarytool 的提交记录,确认是不是超时后被重复提交。"),
    (13, 30, "tool/call", None),
    (13, 31, "tool/result", None),
    (13, 52, "assistant/message", "定位到 notarytool 提交超时后状态仍是 In Progress,改为保留 submission id 并轮询,避免重复提交。"),
    (17, 58, "assistant/message", "自动化任务执行完成,同步了 12 条商品记录。"),
]
DSH_DELIVERABLE = [(14, 5, "docs/requirements.md", "需求文档补充 token 预算与验收标准")]


def at(day, hour, minute):
    return dt.datetime.fromisoformat(day).replace(hour=hour, minute=minute, second=0, microsecond=0, tzinfo=TZ)


def millis(day, hour, minute):
    return int(at(day, hour, minute).timestamp() * 1000)


def text_parts(text, extra=None):
    parts = list(extra or [])
    parts.append({"type": "text", "text": text})
    return parts


def write_codex_sqlite(root, day):
    path = root / ".codex/thread_history_1.sqlite"
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.unlink()
    con = sqlite3.connect(path)
    con.execute(
        "create table thread_items (thread_id text, turn_id text, created_at_ms integer, item_json text, item_type text)"
    )
    rows = []
    for i, (hour, minute, text) in enumerate(CODEX_PROMPTS):
        rows.append((CODEX_SESSION, f"turn-{i:02d}", millis(day, hour, minute),
                     json.dumps({"type": "userMessage", "id": f"um-{i}", "content": text_parts(text)}, ensure_ascii=False),
                     "userMessage"))
    for i, (hour, minute, text) in enumerate(CODEX_RESULTS):
        rows.append((CODEX_SESSION, f"turn-{i:02d}", millis(day, hour, minute),
                     json.dumps({"type": "agentMessage", "id": f"am-{i}", "text": text}, ensure_ascii=False),
                     "agentMessage"))
    for i, (hour, minute, item_type, payload) in enumerate(CODEX_PROCESS):
        rows.append((CODEX_SESSION, f"turn-p{i:02d}", millis(day, hour, minute),
                     json.dumps({"type": item_type, "id": f"pc-{i}", **payload}, ensure_ascii=False),
                     item_type))
    con.executemany("insert into thread_items values (?,?,?,?,?)", rows)
    con.commit()
    con.close()
    return len(rows)


def write_codex_archive(root, day):
    path = root / ".codex/archived_sessions/session-archive.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = []
    for i, (hour, minute, text) in enumerate(CODEX_ARCHIVE):
        lines.append(json.dumps({
            "type": "message", "id": f"arch-{i}", "timestamp": at(day, hour, minute).isoformat(),
            "message": {"role": "assistant", "content": text_parts(text)},
        }, ensure_ascii=False))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return len(lines)


def write_pi(root, day):
    path = root / f".pi/agent/sessions/{PI_SESSION}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = []
    for i, (hour, minute, role, text) in enumerate(PI_EVENTS):
        if role == "toolResult":
            message = {"role": role, "toolCallId": f"call-{i}", "toolName": "bash",
                       "content": [{"type": "text", "text": text}]}
        else:
            extra = [{"type": "thinking", "thinking": "先看采集路径是否会漏掉归档目录"}] if role == "assistant" else None
            message = {"role": role, "content": text_parts(text, extra=extra)}
        lines.append(json.dumps({
            "type": "message", "id": f"pi-{i}", "parentId": None,
            "timestamp": at(day, hour, minute).isoformat(), "message": message,
        }, ensure_ascii=False))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return len(lines)


def write_dsh_zstd(root, day):
    path = root / f".dsh/sessions/{DSH_SESSION}/session.zstd"
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = []
    seq = 0
    for hour, minute, kind, text in DSH_EVENTS:
        seq += 1
        base = {"type": kind, "seq": seq, "time": millis(day, hour, minute)}
        if kind == "user/message":
            base["data"] = {"content": text_parts(text), "role": "user", "id": f"u-{seq}"}
        elif kind == "assistant/message":
            base["data"] = {"turn": 1, "step": seq, "message": {
                "role": "assistant",
                "content": text_parts(text, extra=[{"type": "reasoning", "text": "先确认提交记录再改流水线"}]),
            }}
        elif kind == "tool/call":
            base["data"] = {"turn": 1, "step": seq, "callId": f"c-{seq}", "name": "bash", "arguments": "{}"}
        elif kind == "tool/result":
            base["data"] = {"turn": 1, "step": seq, "message": {
                "role": "tool", "id": f"t-{seq}", "source": "tool",
                "content": [{"type": "tool-result", "text": "notarytool submit: timeout"}],
            }}
        lines.append(json.dumps(base, ensure_ascii=False))
    for hour, minute, target, description in DSH_DELIVERABLE:
        seq += 1
        lines.append(json.dumps({"type": "deliverables/presented", "seq": seq, "time": millis(day, hour, minute),
                                 "data": {"turn": 1, "callId": f"c-{seq}",
                                          "files": [{"path": target, "description": description}]}},
                                ensure_ascii=False))
    raw = ("\n".join(lines) + "\n").encode()
    try:
        proc = subprocess.run(["zstd", "-q", "-c"], input=raw, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except FileNotFoundError:
        return 0
    if proc.returncode != 0:
        return 0
    path.write_bytes(proc.stdout)
    return len(lines)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("root", help="fixture source root (acts as $HOME for the collectors)")
    parser.add_argument("--date", default=dt.datetime.now(TZ).date().isoformat())
    parser.add_argument("--clean", action="store_true", help="remove the root before writing")
    args = parser.parse_args()

    root = Path(args.root).expanduser().resolve()
    if args.clean and root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True, exist_ok=True)

    sqlite_rows = write_codex_sqlite(root, args.date)
    archived = write_codex_archive(root, args.date)
    pi_lines = write_pi(root, args.date)
    dsh_lines = write_dsh_zstd(root, args.date)

    print(f"fixtures root : {root}")
    print(f"fixtures date : {args.date} (UTC+8)")
    print(f"codex         : {len(CODEX_PROMPTS)} 提示词 + {len(CODEX_RESULTS)} 最终结果 + {len(CODEX_PROCESS)} 过程"
          f" = {sqlite_rows} 行,另 {archived} 行归档  session={CODEX_SESSION}")
    print(f"pi            : {pi_lines} 行(2 用户 / 2 助手 / 1 工具结果)  session={PI_SESSION}")
    if dsh_lines:
        print(f"dsh           : {dsh_lines} 行压缩(user/message、assistant/message、tool/*、deliverables)  session={DSH_SESSION}")
    else:
        print("dsh           : skipped (zstd executable missing)")
        print("warning: deepseek-harness fixture was not created", file=sys.stderr)


if __name__ == "__main__":
    main()
