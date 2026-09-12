#!/bin/sh
set -eu
APP_DIR=${DIGEST_HOME:-"$HOME/.local/share/daily-agent-digest"}
RELEASE_BASE=${DIGEST_RELEASE_BASE:-https://github.com/mzlc-linmo/daily-agent-digest-distribution/releases/latest/download}
ENV_FILE=$APP_DIR/.env
PLIST=$HOME/Library/LaunchAgents/com.daily-agent-digest.plist
TRAY_PLIST=$HOME/Library/LaunchAgents/com.daily-agent-digest.tray.plist
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }
command -v shasum >/dev/null 2>&1 || { echo "shasum is required" >&2; exit 1; }
command -v codesign >/dev/null 2>&1 || { echo "codesign is required" >&2; exit 1; }
case "$(uname -s)" in Darwin) ;; *) echo "This installer supports macOS only" >&2; exit 1 ;; esac
case "$(uname -m)" in arm64) ASSET=daily-agent-digest-macos-arm64 ;; x86_64) ASSET=daily-agent-digest-macos-x86_64 ;; *) echo "Unsupported macOS architecture" >&2; exit 1 ;; esac
mkdir -p "$APP_DIR" "$HOME/Library/LaunchAgents"
tmp_bin=$APP_DIR/.${ASSET}.$$
tmp_sums=$APP_DIR/.SHA256SUMS.$$
curl -fsSL "$RELEASE_BASE/$ASSET" -o "$tmp_bin"
curl -fsSL "$RELEASE_BASE/SHA256SUMS" -o "$tmp_sums"
expected=$(awk -v f="$ASSET" '$2 == f || $2 == "*" f { print $1; exit }' "$tmp_sums")
[ -n "$expected" ] || { echo "No checksum found for $ASSET" >&2; exit 1; }
actual=$(shasum -a 256 "$tmp_bin" | awk '{print $1}')
[ "$actual" = "$expected" ] || { echo "SHA256 verification failed" >&2; exit 1; }
codesign --verify --deep --strict "$tmp_bin" 2>/dev/null || { echo "Binary signature verification failed" >&2; exit 1; }
codesign -dv --verbose=4 "$tmp_bin" 2>&1 | grep -q 'Authority=Developer ID Application:' || { echo "Binary is not signed with Developer ID Application" >&2; exit 1; }
chmod 755 "$tmp_bin"
mv -f "$tmp_bin" "$APP_DIR/daily-agent-digest"
# Install the optional native tray controller when the release provides it.
APP_ZIP="$APP_DIR/.tray.$$.zip"
if command -v ditto >/dev/null 2>&1 && curl -fsSL "$RELEASE_BASE/Daily-Agent-Digest-$(uname -m)-app.zip" -o "$APP_ZIP" 2>/dev/null; then
  ditto -x -k "$APP_ZIP" "$APP_DIR" 2>/dev/null || true
  rm -f "$APP_ZIP"
fi
tty_fd=3
tty_open=0
oldstty=
cleanup() {
  if [ -n "$oldstty" ] && [ "$tty_open" -eq 1 ]; then stty "$oldstty" <&3 2>/dev/null || true; fi
  rm -f "$tmp_bin" "$tmp_sums"
}
trap cleanup EXIT HUP INT TERM
shell_quote() { printf "%s" "$1" | sed "s/'/'\\\\''/g; 1s/^/'/; \$s/\$/&'/"; }
if [ ! -f "$ENV_FILE" ]; then
  BASE_URL=${LLM_BASE_URL:-https://api.deepseek.com/v1}; MODEL=${LLM_MODEL:-deepseek-flash}; API_KEY=${LLM_API_KEY:-}
  if [ -z "$API_KEY" ] && { exec 3<>/dev/tty; } 2>/dev/null; then
    tty_open=1
    printf 'LLM_API_KEY (input is hidden): ' >&3
    oldstty=$(stty -g <&3 2>/dev/null || true); stty -echo <&3 2>/dev/null || true
    IFS= read -r API_KEY <&3 || API_KEY=
    printf '\n' >&3
    [ -z "$oldstty" ] || stty "$oldstty" <&3 2>/dev/null || true
    oldstty=
  fi
  BASE_URL=${BASE_URL:-https://api.deepseek.com/v1}; MODEL=${MODEL:-deepseek-flash}
  [ -n "$API_KEY" ] || { echo "LLM_API_KEY is required" >&2; exit 1; }
  umask 077
  { printf 'LLM_BASE_URL='; shell_quote "$BASE_URL"; printf '\nLLM_MODEL='; shell_quote "$MODEL"; printf '\nLLM_API_KEY='; shell_quote "$API_KEY"; printf '\n'; } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi
cat > "$APP_DIR/run.sh" <<EOF
#!/bin/sh
set -eu
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
export LLM_BASE_URL LLM_API_KEY LLM_MODEL
export DIGEST_OUTPUT_DIR=\${DIGEST_OUTPUT_DIR:-"$APP_DIR"}
exec "$APP_DIR/daily-agent-digest" "\$@"
EOF
chmod 755 "$APP_DIR/run.sh"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.daily-agent-digest</string>
<key>ProgramArguments</key><array><string>$APP_DIR/run.sh</string></array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
<key>StartCalendarInterval</key><dict><key>Hour</key><integer>18</integer><key>Minute</key><integer>0</integer></dict>
<key>StandardOutPath</key><string>$APP_DIR/launchd.log</string><key>StandardErrorPath</key><string>$APP_DIR/launchd.error.log</string>
</dict></plist>
EOF
chmod 600 "$PLIST"
if command -v launchctl >/dev/null 2>&1; then launchctl bootout "gui/$(id -u)/com.daily-agent-digest" 2>/dev/null || true; launchctl bootstrap "gui/$(id -u)" "$PLIST"; fi
for app in "$APP_DIR"/Daily\ Agent\ Digest\ *.app; do
  if [ -d "$app" ]; then
    tray_bin="$app/Contents/MacOS/DailyAgentDigest"
    cat > "$TRAY_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>com.daily-agent-digest.tray</string><key>ProgramArguments</key><array><string>$tray_bin</string></array><key>RunAtLoad</key><true/><key>StandardOutPath</key><string>$APP_DIR/tray.log</string><key>StandardErrorPath</key><string>$APP_DIR/tray.error.log</string></dict></plist>
EOF
    chmod 600 "$TRAY_PLIST"
    if command -v launchctl >/dev/null 2>&1; then launchctl bootout "gui/$(id -u)/com.daily-agent-digest.tray" 2>/dev/null || true; launchctl bootstrap "gui/$(id -u)" "$TRAY_PLIST"; fi
    break
  fi
done
echo "Installed daily-agent-digest; scheduled daily at 18:00."
for app in "$APP_DIR"/Daily\ Agent\ Digest\ *.app; do
  if [ -d "$app" ] && command -v open >/dev/null 2>&1; then open -g "$app" >/dev/null 2>&1 || true; break; fi
done
