# Daily Agent Digest

[![Build release binaries](https://github.com/mzlc-linmo/daily-agent-digest/actions/workflows/build-release.yml/badge.svg)](https://github.com/mzlc-linmo/daily-agent-digest/actions/workflows/build-release.yml)

A macOS menu-bar app that turns a day of local AI coding-agent sessions into a short,
structured work digest, then submits it to a team Feishu (Lark) Bitable with one API
address and one API key.

It reads the session logs that AI coding agents already keep on disk — Codex, pi and
DeepSeek Harness — keeps only what a work report needs, and asks a single LLM pass for a
list of work items. You review that list in a menu-bar panel, exclude anything that is not
work, and upload the rest.

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
- **Uploads to your own backend.** Digests are submitted over HTTPS to a Cloudflare Worker
  that writes them into a Feishu Bitable, so a regenerated report overwrites the previous
  version of that day instead of duplicating it.

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

## Submission service

The backend is a zero-dependency Cloudflare Worker in `workers/`: Workers KV stores member
keys, D1 stores an audit log (180-day retention) and the Feishu Bitable is the system of
record. It exposes four member endpoints:

| Endpoint | Purpose |
| --- | --- |
| `GET /healthz` | Liveness, including a Feishu reachability check |
| `GET /api/v1/me` | Who the presented key belongs to (`member`, `member_id`, `key_id`) |
| `GET /api/v1/digests?date=YYYY-MM-DD` | Whether that day was submitted, and its fingerprint |
| `POST /api/v1/digests` | Submit or overwrite one day's digest |

Reads are scoped to the caller's own key: the digest query looks up the record id derived
from the authenticated member, so one member key cannot inspect another member's data.

Keys are only issued by an operator, never self-service: a key is bound to a person at
issuance, and each person has at most one active key. The plaintext key is displayed exactly
once; afterwards only a masked form can be listed. Revoking or rotating a key takes effect
immediately, and every issue, revoke, submit and bootstrap event is written to the audit log.

Operators manage the deployment with a local interactive CLI (arrow-key menus, no
hand-editing of config files):

```bash
cd workers
node scripts/digest-admin.mjs
```

It can run the whole setup in one pass — verify Feishu credentials → create KV/D1 and deploy
the Worker → create the Bitable tables and write back their ids → manage members and keys —
and it can also be driven by subcommands (`install`, `deploy`, `tables`, `members`, `logs`)
for scripted use. See `workers/README.md` and `docs/backend-design.md`.

## Repository layout

```
daily_agent_digest.py        Engine: collection, extraction, summarization, submission
native/macos/                Menu-bar app (Swift/AppKit) and its build script
native/windows/              Windows tray prototype (compiled in CI, not released)
install.sh                   Script installer for macOS
scripts/ci-build.sh          Build + sign the engine, the app bundle and the app zip
scripts/ci-notarize.sh       Notarize + staple the engine, the app and the DMG
scripts/dev.sh               Isolated local development harness
scripts/release-audit.sh     Pre-release audit of release artifacts
tests/test_core.py           Engine protocol tests
workers/                     Cloudflare Worker, D1 schema, admin CLI, Worker tests
docs/                        Requirements baseline, backend design, development notes
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
python3 -m unittest discover -s tests     # 35 engine tests
cd workers && npm test                    # 34 Worker tests
./native/macos/ui-smoke-test.sh           # compiles the app and runs its self-test
```

## Releases

Pushing a `v*` tag builds both architectures on macOS runners and publishes one release with:

- `daily-agent-digest-macos-arm64` / `-x86_64` — standalone engine binaries;
- `Daily-Agent-Digest-arm64.dmg` / `-x86_64.dmg` — drag-to-Applications installers;
- `Daily-Agent-Digest-<arch>-app.zip` — the app bundle;
- `install.sh` and `SHA256SUMS`.

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
