# Daily Agent Digest

## Install

Requirements: macOS, Python 3.10+, and the `zstd` executable for DeepSeek Harness logs.

From this directory:

```bash
./install.sh
```

Or install directly on macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/mzlc-linmo/daily-agent-digest/main/install.sh | sh
```

The installer asks for the API base URL, model, and `LLM_API_KEY`. The key is entered without echo and saved at `~/.local/share/daily-agent-digest/.env` with mode `600`. Re-running the installer preserves the existing file.

This installs a self-contained runner under `~/.local/share/daily-agent-digest` and schedules it daily at 18:00 with macOS `launchd`.

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

## Current limitations

- LLM summarization uses only the first 300 collected work events; it is not a complete daily semantic summary.
- Work-content filtering is delegated to the configured LLM; model quality affects classification.
- The reporting timezone is fixed to UTC+8. The scheduled run at 18:00 excludes work performed after 18:00; run manually later for a complete day.
- Configuring all three LLM variables enables sending selected conversation content to that provider. Keep `.env` private (mode 600).
- Generated reports, credentials, and caches are excluded from Git.
