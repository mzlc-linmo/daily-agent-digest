#!/bin/sh
set -eu
OUT=${1:-build/DailyAgentDigest.app}
VERSION=${DIGEST_RELEASE_VERSION:-dev}
UI_BUILD_ID=${DIGEST_UI_BUILD_ID:-$(git rev-parse --short HEAD 2>/dev/null || printf 'unknown')}
# Releases use the shared identifier; a dev build overrides it so the two
# bundles can coexist in LaunchServices without fighting over the menu bar.
APP_ID=${DIGEST_APP_ID:-com.daily-agent-digest.tray}
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources"

# ---- 图标:App 图标(.icns)+ 菜单栏 Template 图标 ----
ASSETS="$(dirname "$0")/assets"
[ -f "$ASSETS/app-icon-1024.png" ] || { echo "缺少图标源图:$ASSETS/app-icon-1024.png" >&2; exit 1; }
if [ ! -f "$ASSETS/AppIcon.icns" ] || [ "$ASSETS/app-icon-1024.png" -nt "$ASSETS/AppIcon.icns" ]; then
  # 必须显式转成 sRGB:源图的配置会让 iconutil 直接拒绝打包
  rm -rf "$TMP/AppIcon.iconset"; mkdir -p "$TMP/AppIcon.iconset"
  for size in 16 32 128 256 512; do
    for mult in 1 2; do
      px=$((size * mult))
      suffix=""; [ "$mult" = 2 ] && suffix="@2x"
      sips -s format png --matchTo '/System/Library/ColorSync/Profiles/sRGB Profile.icc' \
           -z "$px" "$px" "$ASSETS/app-icon-1024.png" --out "$TMP/AppIcon.iconset/icon_${size}x${size}${suffix}.png" >/dev/null
    done
  done
  iconutil -c icns "$TMP/AppIcon.iconset" -o "$ASSETS/AppIcon.icns"
fi
cp "$ASSETS/AppIcon.icns" "$OUT/Contents/Resources/AppIcon.icns"
# 从同一张源图派生菜单栏单色图标(纯黑+alpha,系统按深浅色自动反色)
swift "$(dirname "$0")/make-menubar-icon.swift" "$ASSETS/app-icon-1024.png" "$ASSETS" >/dev/null
cp "$ASSETS"/MenuBarIconTemplate*.png "$OUT/Contents/Resources/"

# 引擎进包:DMG 安装后不需要额外下载引擎。CI 通过 DIGEST_ENGINE_BIN 指定产物,
  # 本地构建没有引擎时跳过(App 会回退到旧路径,不影响开发)。
ENGINE_BIN=${DIGEST_ENGINE_BIN:-}
if [ -n "$ENGINE_BIN" ] && [ -f "$ENGINE_BIN" ]; then
  cp "$ENGINE_BIN" "$OUT/Contents/Resources/daily-agent-digest"
  chmod 755 "$OUT/Contents/Resources/daily-agent-digest"
  echo "  bundled engine: $ENGINE_BIN"
fi

# 模块缓存显式指向可写目录:受限环境(沙箱/CI)下 TMPDIR 里的缓存不可写,
# 会报 "could not build Objective-C module ..."(Swift 与 Clang 是两套缓存)
export CLANG_MODULE_CACHE_PATH=/tmp/dag-clang-modcache
swiftc "$(dirname "$0")/DailyAgentDigest.swift" -o "$OUT/Contents/MacOS/DailyAgentDigest"
cat > "$OUT/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleInfoDictionaryVersion</key><string>6.0</string><key>CFBundleIdentifier</key><string>$APP_ID</string><key>CFBundleName</key><string>Daily Agent Digest</string><key>CFBundleDisplayName</key><string>Daily Agent Digest</string><key>CFBundleExecutable</key><string>DailyAgentDigest</string><key>CFBundleIconFile</key><string>AppIcon</string><key>LSUIElement</key><true/><key>LSMinimumSystemVersion</key><string>15.0</string><key>NSHighResolutionCapable</key><true/><key>CFBundleShortVersionString</key><string>$VERSION</string><key>CFBundleVersion</key><string>$VERSION</string><key>DigestUIBuildID</key><string>$UI_BUILD_ID</string></dict></plist>
PLIST
