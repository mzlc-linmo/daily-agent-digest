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
- **Can submit to a server (server side not built yet).** The client keeps a working submit
  path — an address plus a key, `POST /api/v1/digests` — but this repository no longer ships
  a backend. See [Submission](#submission-server-side-pending).

## Requirements

- macOS 15 or newer (Apple Silicon or Intel).
- An OpenAI-compatible LLM endpoint (defaults to DeepSeek).
- `zstd` (`brew install zstd`) only if you want DeepSeek Harness sessions collected; macOS
  does not ship it. Without it the other two sources still work and the report says so.
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

If the LLM is unavailable, generation fails with the provider error in the window instead of
silently reporting an empty day.

## Submission (server side pending)

The earlier plan — a Cloudflare Worker writing the digest into a Feishu Bitable — has been
**dropped**, and its code has been removed from this repository. What remains is the client
half of that contract, which still works against any server that implements it:

| Client behaviour | Contract |
| --- | --- |
| 设置 → 提交地址 + 提交 API Key | Stored in `.env` as `DIGEST_SUBMIT_URL` / `DIGEST_API_KEY` (mode `600`) |
| 测试连接 | `GET {DIGEST_SUBMIT_URL}/api/v1/me` with `Authorization: Bearer <key>` → `{member, member_id, key_id}` |
| 上传 | `POST {DIGEST_SUBMIT_URL}/api/v1/digests` with the same header → `{mode: created\|updated\|unchanged, submitted_at}` |
| 上传失败 | Recorded as `submit_status=failed` + `submit_error`; the report is **never** marked as sent unless the server answered with a recognised result |

Until that server exists, use **Markdown** export (below) to hand the report over by hand,
and leave 提交地址 empty — the app then reports `submit_status=not_configured` instead of
pretending the digest was delivered.

> Removed along with the Worker: member keys and their issuance CLI, the D1 audit log, the
> Feishu Bitable writer, and the deployment/recovery tooling. If a future server is built,
> the four endpoints above are all it has to provide.

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
