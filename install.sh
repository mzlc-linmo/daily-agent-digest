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
# Stop the previous tray instance before replacing its bundle. This prevents two menu-bar icons during upgrades.
if command -v launchctl >/dev/null 2>&1; then launchctl bootout "gui/$(id -u)/com.daily-agent-digest.tray" 2>/dev/null || true; fi
pkill -f "$APP_DIR/Daily Agent Digest .*\.app/Contents/MacOS/DailyAgentDigest" 2>/dev/null || true
tmp_bin=$APP_DIR/.${ASSET}.$$
tmp_sums=$APP_DIR/.SHA256SUMS.$$
cache_bust="?installer=$(date +%s)-$$"
release_url=$(curl -fsSL -o /dev/null -w '%{url_effective}' "$RELEASE_BASE/$ASSET$cache_bust")
release_tag=$(printf '%s' "$release_url" | sed -n 's#.*releases/download/\([^/]*\)/.*#\1#p')
if [ -z "$release_tag" ] && [ "$RELEASE_BASE" = "https://github.com/mzlc-linmo/daily-agent-digest-distribution/releases/latest/download" ]; then
  release_tag=$(curl -fsSL 'https://api.github.com/repos/mzlc-linmo/daily-agent-digest-distribution/releases/latest' | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
fi
release_tag=${release_tag:-latest}
curl -fsSL "$RELEASE_BASE/$ASSET$cache_bust" -o "$tmp_bin"
curl -fsSL "$RELEASE_BASE/SHA256SUMS$cache_bust" -o "$tmp_sums"
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
if command -v ditto >/dev/null 2>&1 && curl -fsSL "$RELEASE_BASE/Daily-Agent-Digest-$(uname -m)-app.zip$cache_bust" -o "$APP_ZIP" 2>/dev/null; then
  tray_tmp="$APP_DIR/.tray-extract.$$"; mkdir -p "$tray_tmp"
  ditto -x -k "$APP_ZIP" "$tray_tmp" 2>/dev/null || true
  for new_app in "$tray_tmp"/*.app; do
    if [ -d "$new_app" ]; then
      for old_app in "$APP_DIR"/*.app; do [ -d "$old_app" ] && rm -rf "$old_app"; done
      mv "$new_app" "$APP_DIR/"
      break
    fi
  done
  rm -rf "$tray_tmp"
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
shell_quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
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
else
  # Rewrite legacy incorrectly quoted values produced by older installers.
  . "$ENV_FILE"
  BASE_URL=${LLM_BASE_URL:-https://api.deepseek.com/v1}; MODEL=${LLM_MODEL:-deepseek-flash}; API_KEY=${LLM_API_KEY:-}
  API_KEY=${API_KEY#\"}; API_KEY=${API_KEY#\'}; API_KEY=${API_KEY%\"}; API_KEY=${API_KEY%\'}
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
engine_sha=$(shasum -a 256 "$APP_DIR/daily-agent-digest" | awk '{print $1}')
app_sha=
for installed_app in "$APP_DIR"/*.app; do [ -d "$installed_app" ] && app_sha=$(shasum -a 256 "$installed_app/Contents/MacOS/DailyAgentDigest" | awk '{print $1}') && break; done
umask 077
printf '{"release":"%s","architecture":"%s","engine_sha256":"%s","app_sha256":"%s","installed_at":"%s"}\n' "$release_tag" "$(uname -m)" "$engine_sha" "${app_sha:-}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$APP_DIR/install-manifest.json"
chmod 600 "$APP_DIR/install-manifest.json"
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
<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>com.daily-agent-digest.tray</string><key>ProgramArguments</key><array><string>$tray_bin</string></array><key>EnvironmentVariables</key><dict><key>DIGEST_RELEASE_VERSION</key><string>$release_tag</string><key>DIGEST_DEBUG</key><string>${DIGEST_DEBUG:-0}</string></dict><key>RunAtLoad</key><true/><key>StandardOutPath</key><string>$APP_DIR/tray.log</string><key>StandardErrorPath</key><string>$APP_DIR/tray.error.log</string></dict></plist>
EOF
    chmod 600 "$TRAY_PLIST"
    if command -v launchctl >/dev/null 2>&1; then launchctl bootout "gui/$(id -u)/com.daily-agent-digest.tray" 2>/dev/null || true; launchctl bootstrap "gui/$(id -u)" "$TRAY_PLIST"; fi
    break
  fi
done
echo "Installed daily-agent-digest; scheduled daily at 18:00."
