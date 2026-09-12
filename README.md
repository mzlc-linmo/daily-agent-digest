# Daily Agent Digest

## Install

Requirements: macOS, Python 3.10+, and the `zstd` executable for DeepSeek Harness logs.

From this directory:

```bash
./install.sh
```

This installs a self-contained runner under `~/.local/share/daily-agent-digest` and schedules it daily at 23:55 with macOS `launchd`.

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

Outputs are written to `~/.local/share/daily-agent-digest/YYYY-MM-DD.json` by default. The collector reads `~/.codex`, `~/.pi/agent/sessions`, and `~/.dsh/sessions`. It is read-only and filters obvious personal, entertainment, gaming, and casual conversation before summarization.

## Current limitations

- LLM summarization uses only the first 300 collected work events; it is not a complete daily semantic summary.
- Personal-content filtering uses keywords and can miss personal conversations or exclude work content.
- The reporting timezone is fixed to UTC+8. The scheduled run at 23:55 excludes the remainder of that day.
- Configuring all three LLM variables enables sending selected conversation content to that provider. Keep `.env` private (mode 600).
- Generated reports, credentials, and caches are excluded from Git.
