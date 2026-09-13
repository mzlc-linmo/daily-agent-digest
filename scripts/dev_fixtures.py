#!/usr/bin/env python3
"""Generate an isolated fixture source tree for local development.

Creates codex / pi / deepseek-harness session data under <root> so the engine can
run end to end without reading the developer's real agent history, and without
ever writing to it.

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

# The same sentence is planted in two providers so local duplicate compaction
# (daily_agent_digest.py:142-146) has something to collapse.
SHARED_SENTENCE = "为采集器补了跨 provider 去重，重复摘录在同一份日报里只保留一次。"

# (hour, minute, kind, text)
CODEX_EVENTS = [
    (9, 5, "reasoning", "梳理 Codex 会话表结构，确认 thread_items 的 created_at_ms 可用于按日窗口过滤。"),
    (9, 26, "message", "重构采集器：把三个数据源的窗口过滤抽成同一个 in_window，毫秒与秒级时间戳统一处理。"),
    (10, 2, "message", SHARED_SENTENCE),
    (11, 40, "message", "确定当天日报的 token 预算：单条摘录 900 字符、单次请求上限 90000 字符、工作项上限 20 条。"),
    (14, 12, "message", "整理需求文档：把 14 项功能需求、17 条验收标准与 13 项决策写成 docs/requirements.md。"),
    (16, 30, "message", "午饭想吃什么？随便看看附近新开的面馆，顺便看看周末要不要去露营。"),
]

PI_EVENTS = [
    (10, 3, "message", SHARED_SENTENCE),
    (10, 48, "message", "给 pi 的 jsonl 采集补上 archived_sessions 的兼容读取，避免历史归档漏采。"),
    (15, 20, "message", "把 TZ 固定为 UTC+8 的影响写进需求文档的局限性说明。"),
]

DSH_EVENTS = [
    (13, 15, "tool", "排查 CI 公证失败：notarytool 提交超时后状态仍是 In Progress，改为保留 submission id 而不是重复提交。"),
    (13, 52, "message", "修复 CI 签名：先签内部嵌入式库再签外层二进制，最后 codesign --verify --deep --strict 校验。"),
    (17, 58, "automation", "DigiSeller 定时任务执行完成：同步 12 条商品记录（自动化噪音，不应计入工作项）。"),
]

CODEX_ARCHIVE = [
    (17, 5, "message", "把今天的采集结果与 state.json 做了一次对账，确认排除项在重新生成后仍然保留。"),
]

PI_EXTRA = [
    (17, 22, "message", "记录待办：M1 要修掉 submit 未配置上报地址也标记成功的问题。"),
]


def at(day, hour, minute):
    return dt.datetime.fromisoformat(day).replace(hour=hour, minute=minute, second=0, microsecond=0, tzinfo=TZ)


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
    for i, (hour, minute, kind, text) in enumerate(CODEX_EVENTS):
        items = [
            (CODEX_SESSION, f"turn-{i:02d}", int(at(day, hour, minute).timestamp() * 1000), json.dumps({"text": text, "role": "user"}, ensure_ascii=False), kind),
            (CODEX_SESSION, f"turn-{i:02d}", int(at(day, hour, minute).timestamp() * 1000) + 1500, json.dumps({"text": f"[fixture reply {i}]", "role": "assistant"}, ensure_ascii=False), "message"),
        ]
        rows.extend(items)
    con.executemany("insert into thread_items values (?,?,?,?,?)", rows)
    con.commit()
    con.close()
    return len(rows)


def write_jsonl(path, day, events, session_prefix):
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = []
    for i, (hour, minute, kind, text) in enumerate(events):
        lines.append(json.dumps({
            "timestamp": at(day, hour, minute).isoformat(),
            "id": f"{session_prefix}-{i:02d}",
            "type": kind,
            "content": text,
        }, ensure_ascii=False))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return len(lines)


def write_dsh_zstd(root, day):
    import io
    path = root / f".dsh/sessions/{DSH_SESSION}/session.zstd"
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = []
    for i, (hour, minute, kind, text) in enumerate(DSH_EVENTS):
        lines.append(json.dumps({
            "time": at(day, hour, minute).isoformat(),
            "seq": i,
            "type": kind,
            "text": text,
        }, ensure_ascii=False))
    raw = ("\n".join(lines) + "\n").encode()
    buffer = io.BytesIO()
    try:
        proc = subprocess.run(["zstd", "-q", "-c"], input=raw, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except FileNotFoundError:
        return 0
    if proc.returncode != 0:
        return 0
    buffer.write(proc.stdout)
    path.write_bytes(buffer.getvalue())
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
    archived = write_jsonl(root / ".codex/archived_sessions/session-archive.jsonl", args.date, CODEX_ARCHIVE, "arch")
    pi_lines = write_jsonl(root / f".pi/agent/sessions/{PI_SESSION}.jsonl", args.date, PI_EVENTS + PI_EXTRA, PI_SESSION)
    dsh_lines = write_dsh_zstd(root, args.date)

    print(f"fixtures root : {root}")
    print(f"fixtures date : {args.date} (UTC+8)")
    print(f"codex         : {len(CODEX_EVENTS)} turns / {sqlite_rows} items + {archived} archived line(s)  session={CODEX_SESSION}")
    print(f"pi            : {pi_lines} line(s)  session={PI_SESSION}")
    if dsh_lines:
        print(f"dsh           : {dsh_lines} compressed line(s)  session={DSH_SESSION}")
    else:
        print("dsh           : skipped (zstd executable missing)")
    if dsh_lines == 0:
        print("warning: deepseek-harness fixture was not created", file=sys.stderr)


if __name__ == "__main__":
    main()
