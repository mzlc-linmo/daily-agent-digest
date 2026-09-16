# Daily Agent Digest

[![Build release binaries](https://github.com/mzlc-linmo/daily-agent-digest/actions/workflows/build-release.yml/badge.svg)](https://github.com/mzlc-linmo/daily-agent-digest/actions/workflows/build-release.yml)

A macOS menu-bar app that turns a day of local AI coding-agent sessions into a short,
structured work digest — one LLM pass, a list of work items you can edit — then exports it as
Markdown or sends it to a server you point it at.

It reads the session logs that AI coding agents already keep on disk — Codex, pi and
DeepSeek Harness — keeps only what a work report needs, and asks a single LLM pass for a
list of work items. You review that list in a menu-bar panel, exclude anything that is not
work, and export the rest.

## What it does

- **Collects locally and read-only** from `~/.codex`, `~/.pi/agent/sessions` and
  `~/.dsh/sessions`. Nothing is written back to those directories.
- **Drops process noise before any truncation**: tool calls, search results, code blocks,
  command output and internal reasoning never enter the summary pass. Extraction is
  structured (by record field), not keyword matching, so one long record cannot lose its
  text.
- **Produces a structured report, not prose.** The LLM returns `{title, desc}` per work
  item; the app renders each included item as a heading plus its own body. Excluding an
  item is a plain array filter — instant, no extra LLM call, fully reversible.
- **Exports the report as Markdown.** One button in the report window opens the day's report
  as a Markdown document you can copy or save, ready to paste into a wiki, a ticket or a chat.
- **Submits to the 工作日志管理 module.** The client keeps a working submit path — an address
  plus an API key, `POST /admin/enterprise/worklog/api/report` — against the Work Log module of
  the `linmo-pig-full` server. See [Submission](#submission).

## Requirements

- macOS 15 or newer (Apple Silicon or Intel).
- An OpenAI-compatible LLM endpoint (defaults to DeepSeek).
- `zstd` (`brew install zstd`) only if you want DeepSeek Harness sessions collected; macOS
  does not ship it. The engine looks for it in `PATH` **and** in the usual install locations
  (`/opt/homebrew/bin`, `/usr/local/bin`, `/opt/anaconda3/bin`, `~/.local/bin`), because an app
  launched from Finder or a login item does not inherit your shell's `PATH` — set `DIGEST_ZSTD`
  to override. Without it the other sources still work and the report says so in its warnings.
- No system Python is required: the engine ships inside the app (and the standalone release
  asset is a self-contained PyInstaller binary).

## Install

### Option 1: DMG (recommended)

Download `Daily-Agent-Digest-<arch>.dmg` from the
[latest release](https://github.com/mzlc-linmo/daily-agent-digest/releases/latest), open it
and drag **Daily Agent Digest** into Applications. The engine is bundled inside the app, so
it works straight from the disk image.

The release is Developer ID signed, notarized by Apple and stapled, so Gatekeeper accepts it
offline. On first launch, open the menu-bar icon → **设置** and fill in the LLM API key.

The app ships its engine as a directory build, so each menu action does not pay an unpack
cost. The only slow moment is the very first engine start after installing, while macOS
validates the bundled binaries for the first time; afterwards the app answers immediately.

### Option 2: install script

```bash
curl -fsSL https://github.com/mzlc-linmo/daily-agent-digest/releases/latest/download/install.sh | sh
```

The installer verifies the release SHA256 and the Developer ID signature, installs the
engine and the tray app under `~/Library/Application Support/Daily Agent Digest`, and
registers a `launchd` job that runs the digest daily at 18:00. It prompts once for
`LLM_API_KEY` (input hidden, file mode `600`); re-running it preserves your existing
configuration.

### Option 3: build a local DMG without an Apple certificate

```bash
scripts/build-dmg.sh                  # tests → engine → app → ad-hoc sign → DMG
scripts/build-dmg.sh --skip-tests     # faster rebuild
DIGEST_RELEASE_VERSION=v0.6.9 scripts/build-dmg.sh
```

It creates `.build/venv` with PyInstaller pinned to the CI version (your system Python is
untouched), bundles the onedir engine into the app, ad-hoc signs every Mach-O, and writes
`dist/Daily-Agent-Digest-<version>-<arch>.dmg`. Before packing it asserts the app resolves the
**bundled** engine and that the engine really executes; afterwards it mounts the image and
re-checks the app, its signature and the drag-to-Applications shortcut.

The result is **not notarized**, so Gatekeeper rejects it on other machines until the
quarantine flag is cleared:

```bash
xattr -dr com.apple.quarantine "/Applications/Daily Agent Digest.app"
```

`DIGEST_RELEASE_VERSION` also becomes the `release_version` reported with each digest, so use
a real version rather than the `dev` default if the digests are uploaded to a server.

## Using the menu-bar app

| Menu item | What it does |
| --- | --- |
| 查看今日总结 | Opens the report window |
| 生成今日总结 | Regenerates today's report (always refreshes) |
| 设置 | LLM and submission settings, with an inline connection test |
| 开机自启 | Toggles "launch at login"; a checkmark shows whether it is currently on |
| 关于 | Version, engine path and data directory |
| 退出 | Quits the app |

In the report window each work item shows a heading, its body and a `×` button: excluding an
item removes it from the report immediately, and 恢复 puts it back. The **上传** button
submits the current report to the backend. The window footer shows the character count and
the coverage of the collection pass.

Automatic behaviour, driven by a 60-second tick (so no scheduler of its own is needed):

- after **17:30** the app generates the preview once, if it has not already;
- after **18:00** it submits once, and only if the report is ready, unmodified and a
  submission address is configured.

For this to happen the app has to be running, so it registers itself as a login item on
first launch; 开机自启 turns that off and on. A DMG install therefore needs no scheduler
setup at all, while the script install also gets a `launchd` job that runs at 18:00 even if
nobody is signed in to the menu bar app.

Both times are UTC+8. Work done after the cutoff is not included; press 生成今日总结 later
for a complete day.

## Configuration

Settings live in one `.env` file (mode `600`) in the application data directory. You can edit
them from 设置 or directly:

```bash
export DIGEST_HOME="$HOME/Library/Application Support/Daily Agent Digest"
cat "$DIGEST_HOME/.env"
```

| Variable | Purpose | Default |
| --- | --- | --- |
| `LLM_BASE_URL` | OpenAI-compatible endpoint | `https://api.deepseek.com/v1` |
| `LLM_API_KEY` | Key for that endpoint | — |
| `LLM_MODEL` | Model name | `deepseek-flash` |
| `DIGEST_SUBMIT_URL` | Backend submit address; unset disables uploading | — |
| `DIGEST_API_KEY` | Member key issued by the backend operator | — |
| `DIGEST_HOME` | Application data directory | `~/Library/Application Support/Daily Agent Digest` |
| `DIGEST_OUTPUT_DIR` | Where `--date` writes its JSON | `$DIGEST_HOME` |
| `DIGEST_DEBUG` | Set to `1` for a redacted `tray.debug.log` | off |

The `launchd` job does not read your interactive shell profile, so put settings in `.env`
rather than in a shell rc file.

## How a digest is built

1. **Collect** — one read-only pass over the three session stores for the local day. Each
   collector is independent: a missing or unreadable store is reported in `coverage` rather
   than failing the run.
2. **Extract** — keep the user's prompts, the assistant's final answers and the delivered
   files; drop everything else.
3. **Rank and fit** — prompts first, then results, then deliverables, rotated across
   providers so one source cannot crowd out another, capped at 90,000 characters for the
   request.
4. **Summarize** — one LLM call returns the work items as JSON.
5. **Fit the report** — the whole report (all titles and bodies) is capped at 1,000
   characters and each body is capped at 300 (target 100–300). When there are many items the
   bodies are compressed rather than dropping items. Limits are applied locally, so the
   model cannot exceed them.
6. **Review and submit** — exclude what is not work, then upload.

### When the report is incomplete, it says so

A report can be incomplete for reasons that have nothing to do with the window: the LLM may be
unconfigured or may return nothing usable, `zstd` may be missing so DeepSeek Harness sessions
cannot be read, a session database may be unreadable. None of that is allowed to look like a
finished digest:

- the engine records `report_status=error` with the reason in `last_error`, and puts every
  reason into a `warnings` list (unclassified report, missing `zstd`, unreadable database,
  collector failure);
- the report window shows those warnings in orange under the title, so a report missing half
  its sources is never mistaken for a quiet day;
- the Markdown export carries them as `> ⚠️` lines at the top, because that document gets
  forwarded;
- 上传 refuses a report that was never classified (`submit_status=failed`, 「日报未完成主题
  归并,拒绝上报」) rather than sending provider-grouped placeholders to the server.

An agent you simply do not use does not raise a warning — a missing `~/.codex` is only reported
when the directory exists but its database is gone.

If the LLM is unavailable, the report still lists what was collected, grouped by provider, so
you can see which sources had sessions at all.

## Submission

Digests are uploaded to the **工作日志管理 (Work Log) module** of the `linmo-pig-full`
server. The earlier Cloudflare Worker + Feishu Bitable plan was dropped, and its code removed;
the client now speaks that module's API directly.

| Client behaviour | Contract |
| --- | --- |
| 设置 → 提交地址 + 提交 API Key | Base address (`http://host/api`) **or** the full endpoint URL — both work; stored in `.env` as `DIGEST_SUBMIT_URL` / `DIGEST_API_KEY` (mode `600`) |
| 上传 | `POST {DIGEST_SUBMIT_URL}/admin/enterprise/worklog/api/report`, `X-API-Key: <key>` → `{"code":0,"data":{"result":"created\|updated\|unchanged",...}}` |
| 测试连接 | There is **no** separate key-check endpoint (the key's 授权URL whitelists only the report URL), so it uploads today's digest once and reads the member name back out of the response |
| Identity | Comes from the key alone — the client sends no name, staff number or e-mail |
| Report date | Decided by the **server's** day; the client's `date` is kept for the record only |
| Overwrite | Same member + same server day = one row, updated in place. Identical payload → `unchanged`, no write |
| 上传失败 | Recorded as `submit_status=failed` + `submit_error`; the report is **never** marked as sent unless the server answered with a recognised `result` |

Leave 提交地址 empty and the app reports `submit_status=not_configured` instead of pretending
the digest was delivered; **Markdown** export (below) remains available for hand-over.

**The full contract — API-key creation requirements (including the 授权URL trap), request and
response shapes, field limits, overwrite/idempotency semantics, the failure table and
ready-to-run `curl` examples — is in [`docs/backend-api.md`](docs/backend-api.md) (Chinese).**

## 日报 Markdown

The report window has a **Markdown** button. It opens the current report as a Markdown
document — one `##` heading per included item, its body underneath, and a small metadata
footer (date, item count, character count):

```markdown
# 今日工作日报 · 2026-09-14

## 1. 修复日报提交的重复写入

把提交改为按天覆盖,重新生成不再产生重复行……

## 2. 梳理托盘菜单

……

---

- 日期:2026-09-14
- 工作项:2 项
- 正文合计:412 字
```

Excluded items are not in the document, so the Markdown always matches what the window shows.
If the report is incomplete (see below), the document opens with `> ⚠️` lines naming the reason —
an unclassified or half-collected report must not read like a finished summary.
The panel offers 复制 (to the clipboard) and 保存为 .md…, and the text can be selected
directly.

## Repository layout

```
daily_agent_digest.py        Engine: collection, extraction, summarization, Markdown/submit
native/macos/                Menu-bar app (Swift/AppKit) and its build script
native/windows/              Windows tray prototype (compiled in CI, not released)
install.sh                   Script installer for macOS
scripts/ci-build.sh          Build + sign the engine, the app bundle and the app zip
scripts/ci-notarize.sh       Notarize + staple the engine, the app and the DMG
scripts/dev.sh               Isolated local development harness
scripts/release-audit.sh     Pre-release audit of release artifacts
tests/test_core.py           Engine protocol tests
docs/backend-api.md          Contract for the (future) submission server
docs/                        Requirements baseline and development notes
```

## Local development

Everything runs against an isolated data directory under `.dev/`; the harness never touches
an installed copy and registers no `launchd` service:

```bash
./scripts/dev.sh setup      # isolated home, .env, fixture sources, engine wrapper
./scripts/dev.sh test       # unit tests
./scripts/dev.sh generate   # offline end-to-end generation with a mock LLM
./scripts/dev.sh app        # build and launch the dev menu-bar app
./scripts/dev.sh status     # what is running and where the state lives
```

`generate --mode=malformed|error500|hang` injects LLM failures to exercise the error paths.
See `docs/development.md` (Chinese) for the full command list and isolation guarantees.

Tests:

```bash
python3 -m unittest discover -s tests     # engine tests
./native/macos/ui-smoke-test.sh           # compiles the app and runs its self-test
```

## Releases

Pushing a `v*` tag builds both architectures on macOS runners and publishes one release with:

| Asset | What it is | How to use it |
| --- | --- | --- |
| `Daily-Agent-Digest-arm64.dmg` / `-x86_64.dmg` | Drag-to-Applications installer (**this is what you want**) | Open it, drag the app into Applications |
| `Daily-Agent-Digest-<arch>-app.zip` | The app bundle, used by `install.sh` | Unzip, or let `install.sh` handle it |
| `daily-agent-digest-macos-arm64` / `-x86_64` | The engine executable — a **Mach-O binary**, not a text file | Run it from a terminal; never double-click it |
| `install.sh` + `SHA256SUMS` | Script installer and checksums | `curl … \| sh`, or `shasum -a 256 -c SHA256SUMS` |

> **Don't double-click the bare `daily-agent-digest-macos-*` asset.** It has no file
> extension and no app bundle, so macOS hands it to TextEdit, which fails with 「文本编码
> Unicode (UTF-8) 不适用」. That dialog means the file is fine — it is a program, not
> a document. To use it anyway:
>
> ```bash
> chmod +x daily-agent-digest-macos-arm64       # browsers may drop the executable bit
> ./daily-agent-digest-macos-arm64 --help
> ```
>
> It is a command-line engine: it reads `~/Library/Application Support/Daily Agent Digest/.env`
> and prints JSON. All day-to-day use goes through the menu-bar app, whose settings live behind
> the tray menu → 设置 — there is no config file to open by hand.

When the Apple signing secrets are configured (`APPLE_CERTIFICATE_BASE64`,
`APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_APP_PASSWORD`,
`APPLE_TEAM_ID`), the engine, the app bundle and the DMG are all notarized and stapled, and a
signed release is published. Without them a manual run produces an unsigned draft for
verification only, and a signed release is refused rather than published incomplete.

## Uninstall

```bash
launchctl bootout "gui/$(id -u)/com.daily-agent-digest" 2>/dev/null || true
launchctl bootout "gui/$(id -u)/com.daily-agent-digest.tray" 2>/dev/null || true
rm -rf "$HOME/Library/Application Support/Daily Agent Digest"
rm -f "$HOME/Library/LaunchAgents/com.daily-agent-digest"*.plist
```

Then delete the app from Applications.

## Limitations

- macOS only. The Windows tray is an unshipped prototype in `native/windows/`.
- The report is a summary of what the configured LLM considers work; model quality affects
  classification. Review before uploading.
- The reporting day is fixed to UTC+8 and the automatic cutoff is 18:00.
- Configuring the `LLM_*` variables sends selected conversation content to that provider.
  Keep `.env` at mode `600`.
- PyInstaller packages Python bytecode; it is not source protection.

## License

MIT — see [LICENSE](LICENSE).
