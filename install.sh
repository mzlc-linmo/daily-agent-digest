#!/bin/sh
set -eu
APP_DIR="${DIGEST_HOME:-$HOME/.local/share/daily-agent-digest}"
RAW_BASE="${DIGEST_RAW_BASE:-https://raw.githubusercontent.com/mzlc-linmo/daily-agent-digest/main}"
RELEASE_BASE="${DIGEST_RELEASE_BASE:-https://github.com/mzlc-linmo/daily-agent-digest-distribution/releases/latest/download}"
mkdir -p "$APP_DIR" "$HOME/Library/LaunchAgents"
SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f "$SOURCE_DIR/daily_agent_digest.py" ]; then
  cp "$SOURCE_DIR/daily_agent_digest.py" "$APP_DIR/daily_agent_digest.py"
else
  command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }
  ARCH=$(uname -m)
  case "$ARCH" in arm64) ASSET=daily-agent-digest-macos-arm64;; x86_64) ASSET=daily-agent-digest-macos-x86_64;; *) echo "Unsupported macOS architecture: $ARCH" >&2; exit 1;; esac
  curl -fsSL "$RELEASE_BASE/$ASSET" -o "$APP_DIR/daily-agent-digest"
  chmod 755 "$APP_DIR/daily-agent-digest"
fi
if [ -f "$APP_DIR/daily_agent_digest.py" ]; then chmod 755 "$APP_DIR/daily_agent_digest.py"; fi
ENV_FILE="$APP_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  printf 'DeepSeek/OpenAI-compatible API base URL [https://api.deepseek.com/v1]: '
  read -r BASE_URL
  BASE_URL=${BASE_URL:-https://api.deepseek.com/v1}
  printf 'LLM model [deepseek-flash]: '
  read -r MODEL
  MODEL=${MODEL:-deepseek-flash}
  printf 'LLM_API_KEY (input is hidden): '
  stty -echo 2>/dev/null || true; read -r API_KEY; stty echo 2>/dev/null || true; printf '\n'
  [ -n "$API_KEY" ] || { echo "LLM_API_KEY cannot be empty" >&2; exit 1; }
  umask 077
  printf 'LLM_BASE_URL=%s\nLLM_MODEL=%s\nLLM_API_KEY=%s\n' "$BASE_URL" "$MODEL" "$API_KEY" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
else
  echo "Using existing $ENV_FILE"
fi
cat > "$APP_DIR/run.sh" <<EOF
#!/bin/sh
if [ -f "$APP_DIR/.env" ]; then . "$APP_DIR/.env"; export LLM_BASE_URL LLM_API_KEY LLM_MODEL DIGEST_OUTPUT_DIR; fi
if [ -x "$APP_DIR/daily-agent-digest" ]; then exec "$APP_DIR/daily-agent-digest"; fi
exec /usr/bin/python3 "$APP_DIR/daily_agent_digest.py"
EOF
chmod 755 "$APP_DIR/run.sh"
cat > "$HOME/Library/LaunchAgents/com.daily-agent-digest.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.daily-agent-digest</string>
<key>ProgramArguments</key><array><string>$APP_DIR/run.sh</string></array>
<key>StartCalendarInterval</key><dict><key>Hour</key><integer>18</integer><key>Minute</key><integer>0</integer></dict>
<key>StandardOutPath</key><string>$APP_DIR/launchd.log</string><key>StandardErrorPath</key><string>$APP_DIR/launchd.error.log</string>
</dict></plist>
EOF
launchctl bootout "gui/$(id -u)/com.daily-agent-digest" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.daily-agent-digest.plist"
echo "Installed. Put LLM_BASE_URL, LLM_API_KEY, LLM_MODEL in $APP_DIR/.env, then run: $APP_DIR/run.sh"
