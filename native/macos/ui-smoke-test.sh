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
echo "== menu structure =="
MENU=$("$BIN" --dump-menu)
printf '%s\n' "$MENU" | sed 's/^/  /'
printf '%s\n' "$MENU" | grep -q '^开机自启|toggleLoginItem|' || {
  echo "smoke: 菜单缺少「开机自启」项" >&2; exit 1; }
# 对勾必须与系统里登录项的真实状态一致(读的是 SMAppService,不是我们的意图)
DECLARED=$(printf '%s\n' "$MENU" | awk -F'|' '/^login-item-enabled/{print $2}')
SHOWN=$(printf '%s\n' "$MENU" | awk -F'|' '/^开机自启/{print $3}')
[ "$DECLARED" = "$SHOWN" ] || {
  echo "smoke: 「开机自启」对勾与系统状态不一致(菜单=$SHOWN,系统=$DECLARED)" >&2; exit 1; }
case "$SHOWN" in
  on|off) echo "login item checkmark=$SHOWN (matches SMAppService)" ;;
  *) echo "smoke: 对勾状态无法识别 -> $SHOWN" >&2; exit 1 ;;
esac
# 对勾必须真的会变:不然上面那条断言在"本来就关着"的环境里会空过
CHECK_ON=$(printf '%s\n' "$MENU" | awk -F'|' '/^checkmark-when-enabled/{print $2}')
CHECK_OFF=$(printf '%s\n' "$MENU" | awk -F'|' '/^checkmark-when-disabled/{print $2}')
[ "$CHECK_ON" = on ] || { echo "smoke: 开启状态下没有打对勾 -> $CHECK_ON" >&2; exit 1; }
[ "$CHECK_OFF" = off ] || { echo "smoke: 关闭状态下仍有对勾 -> $CHECK_OFF" >&2; exit 1; }
echo "checkmark follows state: enabled->on, disabled->off"

echo
echo "ui smoke test passed"
