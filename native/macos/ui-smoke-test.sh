#!/bin/bash
# UI smoke test for the macOS tray app.
#
# Builds the bundle and runs its headless self-test, which asserts the mappings
# that previously made a failed generation look successful. Also checks that the
# bundle carries the provenance fields the report window displays.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../.." && pwd)
OUT=${1:-"$REPO/build/ui-smoke/Daily Agent Digest.app"}
VERSION=${DIGEST_RELEASE_VERSION:-smoke}

DIGEST_RELEASE_VERSION="$VERSION" \
DIGEST_UI_BUILD_ID="${DIGEST_UI_BUILD_ID:-smoke}" \
DIGEST_APP_ID="${DIGEST_APP_ID:-com.daily-agent-digest.tray.smoke}" \
  bash "$REPO/native/macos/build.sh" "$OUT" >/dev/null

BIN="$OUT/Contents/MacOS/DailyAgentDigest"
[ -x "$BIN" ] || { echo "smoke: executable missing at $BIN" >&2; exit 1; }

echo "== bundle provenance =="
/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$OUT/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$OUT/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Print :DigestUIBuildID' "$OUT/Contents/Info.plist"
/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$OUT/Contents/Info.plist"

echo
echo "== headless outcome mapping self-test =="
"$BIN" --self-test

echo
echo "== bundled engine resolution =="
# 发布版的引擎装在 Contents/Resources/engine(onedir)。放一个占位可执行文件,
# 断言 App 优先选它 —— 选错就会退回旧的 onefile 布局,启动又要几秒。
ENGINE="$OUT/Contents/Resources/engine/daily-agent-digest"
mkdir -p "$(dirname "$ENGINE")"
printf '#!/bin/sh\nexit 0\n' > "$ENGINE"
chmod +x "$ENGINE"
RESOLVED=$("$BIN" --engine-path)
case "$RESOLVED" in
  */Contents/Resources/engine/daily-agent-digest) echo "engine=$RESOLVED" ;;
  *) echo "smoke: App 没有优先使用包内 onedir 引擎 -> $RESOLVED" >&2; exit 1 ;;
esac

echo
echo "ui smoke test passed"
