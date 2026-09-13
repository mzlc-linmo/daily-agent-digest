# Daily Agent Digest

## Install

Requirements: macOS, Python 3.10+, and the `zstd` executable for DeepSeek Harness logs.

From this directory:

```bash
./install.sh
```

Or install directly on macOS:

```bash
curl -fsSL https://github.com/mzlc-linmo/daily-agent-digest-distribution/releases/latest/download/install.sh | sh
```

The installer asks only for `LLM_API_KEY`. Base URL defaults to `https://api.deepseek.com/v1` and model defaults to `deepseek-flash`; both can be changed from the tray application's Settings menu or by editing `~/.local/share/daily-agent-digest/.env`. The key is entered without echo and saved with mode `600`. Re-running the installer preserves the existing file.

This installs a self-contained binary runner under `~/.local/share/daily-agent-digest` and schedules it daily at 18:00 with macOS `launchd`.

The tray controller uses the same runner protocol (`--app-command state|generate|exclude|restore|settings|save-settings|submit|tick`). It shows one work item per row and persists exclusions in `state.json`. At 17:30 it generates the day's preview; at 18:00 it submits all non-excluded items. Set `DIGEST_SUBMIT_URL` to enable the reserved JSON POST endpoint.

Set `DIGEST_DEBUG=1` in the runner environment to write provider and protocol errors to `debug.log` under the application directory. Reports are generated with one daily thematic LLM pass after local duplicate removal and excerpt truncation; if the LLM is unavailable, the fallback groups records by provider rather than exposing individual session rows.

Production installs download a signed/released binary from `DIGEST_RELEASE_BASE`. The default points to the public distribution repository `mzlc-linmo/daily-agent-digest-distribution`; configure it to your public release host before publishing.

For CI publishing, add a fine-grained secret named `DISTRIBUTION_REPO_TOKEN` to the private source repository. It needs Contents: Read and write permission on `mzlc-linmo/daily-agent-digest-distribution`. Push a tag such as `v0.1.0` to build and publish both macOS binaries there.

Manual workflow dispatch builds both architectures and uploads an unsigned draft Release to verify cross-repository permissions. Drafts are not public downloads. Version tags require Developer ID signing and Apple notarization before any public release can be created. The initial public installation URL will only work after the first signed release.

Required source-repository secrets for version tags:

- `APPLE_CERTIFICATE_BASE64`: Base64-encoded Developer ID Application certificate and private key exported as `.p12`.
- `APPLE_CERTIFICATE_PASSWORD`: Password protecting that `.p12` export.
- `APPLE_SIGNING_IDENTITY`: Full Developer ID Application identity name.
- `APPLE_ID`: Apple Developer account email.
- `APPLE_APP_PASSWORD`: App-specific password for notarization.
- `APPLE_TEAM_ID`: Apple Developer team identifier.

CI uses macOS 15 arm64 and Intel runners, checks binary architecture, runs an empty-input CLI test, and generates `SHA256SUMS`. Keep certificates and private keys exclusively in Actions Secrets. PyInstaller packages Python bytecode; it does not provide irreversible source protection.

Configure an OpenAI-compatible endpoint in `~/.local/share/daily-agent-digest/.env` (the launchd job does not read your interactive shell profile):

```bash
export LLM_BASE_URL="https://api.deepseek.com/v1"
export LLM_API_KEY="..."
export LLM_MODEL="deepseek-flash"
```

## Manual run

```bash
python3 daily_agent_digest.py --date 2026-09-11
```

Outputs are written to `~/.local/share/daily-agent-digest/YYYY-MM-DD.json` by default. The collector reads `~/.codex`, `~/.pi/agent/sessions`, and `~/.dsh/sessions`. It is read-only; the LLM decides which collected conversations are genuine work.

Before the single daily LLM pass the engine selects what to send: it deduplicates, drops scheduled-automation records locally, ranks excerpts (human messages and assistant narratives before tool/command output) and rotates across providers so no single source can crowd out the others, within a 90,000-character budget. The resulting counts are recorded in `coverage` and shown at the bottom of the report window.

Each report is a **structured list of work items**, not a free-text narrative: the LLM returns `{title, desc}` per item, and the report window renders every *included* item as a heading plus its own body. The whole report (all titles + all bodies) is capped at 1000 characters; each body targets 100-300 characters and bodies are compressed rather than dropping items when there are many. Because items are independent, excluding one is a plain array filter: it disappears from the report instantly, costs no LLM call, and is fully reversible. The engine clamps the model output locally and records `report_chars` for verification.

## Local development

Run the engine and the tray app from source against an isolated data directory under `.dev/` (never touches an installed copy, registers no launchd service):

```bash
./scripts/dev.sh setup      # isolated home, .env, fixture data sources, engine wrapper
./scripts/dev.sh test       # unit tests
./scripts/dev.sh generate   # offline end-to-end generation with a built-in mock LLM
./scripts/dev.sh app        # build and launch the dev menu bar app
./scripts/dev.sh status     # what is running and where the dev state lives
```

`generate --mode=malformed|error500|hang` injects LLM failures to exercise the error paths. See `docs/development.md` (Chinese) for the full command list, isolation guarantees and rollback of an installed copy.

## Requirements baseline

`docs/requirements.md` is the confirmed requirements baseline (team-internal use, Feishu group reporting, macOS only). It supersedes the earlier production delivery plan.

## Current limitations

- LLM summarization sends at most the first 500 deduplicated excerpts, capped at 30,000 characters; it is not a complete daily semantic summary.
- Work-content filtering is delegated to the configured LLM; model quality affects classification.
- The reporting timezone is fixed to UTC+8. The scheduled run at 18:00 excludes work performed after 18:00; run manually later for a complete day.
- Configuring all three LLM variables enables sending selected conversation content to that provider. Keep `.env` private (mode 600).
- Generated reports, credentials, and caches are excluded from Git.
