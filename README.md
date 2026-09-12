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

The installer asks for the API base URL, model, and `LLM_API_KEY`. The key is entered without echo and saved at `~/.local/share/daily-agent-digest/.env` with mode `600`. Re-running the installer preserves the existing file.

This installs a self-contained binary runner under `~/.local/share/daily-agent-digest` and schedules it daily at 18:00 with macOS `launchd`.

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

## Current limitations

- LLM summarization uses only the first 300 collected work events; it is not a complete daily semantic summary.
- Work-content filtering is delegated to the configured LLM; model quality affects classification.
- The reporting timezone is fixed to UTC+8. The scheduled run at 18:00 excludes work performed after 18:00; run manually later for a complete day.
- Configuring all three LLM variables enables sending selected conversation content to that provider. Keep `.env` private (mode 600).
- Generated reports, credentials, and caches are excluded from Git.
