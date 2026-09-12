#!/bin/sh
set -eu
APP_DIR="${DIGEST_HOME:-$HOME/.local/share/daily-agent-digest}"
mkdir -p "$APP_DIR" "$HOME/Library/LaunchAgents"
cp "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/daily_agent_digest.py" "$APP_DIR/daily_agent_digest.py"
chmod 755 "$APP_DIR/daily_agent_digest.py"
cat > "$APP_DIR/run.sh" <<EOF
#!/bin/sh
if [ -f "$APP_DIR/.env" ]; then . "$APP_DIR/.env"; export LLM_BASE_URL LLM_API_KEY LLM_MODEL DIGEST_OUTPUT_DIR; fi
exec /usr/bin/python3 "$APP_DIR/daily_agent_digest.py"
EOF
chmod 755 "$APP_DIR/run.sh"
cat > "$HOME/Library/LaunchAgents/com.daily-agent-digest.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.daily-agent-digest</string>
<key>ProgramArguments</key><array><string>$APP_DIR/run.sh</string></array>
<key>StartCalendarInterval</key><dict><key>Hour</key><integer>23</integer><key>Minute</key><integer>55</integer></dict>
<key>StandardOutPath</key><string>$APP_DIR/launchd.log</string><key>StandardErrorPath</key><string>$APP_DIR/launchd.error.log</string>
</dict></plist>
EOF
launchctl bootout "gui/$(id -u)/com.daily-agent-digest" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.daily-agent-digest.plist"
echo "Installed. Put LLM_BASE_URL, LLM_API_KEY, LLM_MODEL in $APP_DIR/.env, then run: $APP_DIR/run.sh"
