#!/bin/sh
# 发布产物审计:把 release 里的每个交付物下载下来,校验校验和、签名、公证与装订。
#
# 这份脚本此前只覆盖两个引擎二进制和 app.zip —— DMG 成为主要交付物之后从未被审计过,
# 于是一个 Gatekeeper 判定为 "the code is valid but does not seem to be an app" 的
# 安装包就这么发布了。DMG 现在被真实挂载并按用户的方式检验。
#
# 用法: release-audit.sh [REPO] TAG
set -eu
repo=${1:-mzlc-linmo/daily-agent-digest}
tag=${2:?usage: release-audit.sh REPO TAG}
base="https://github.com/$repo/releases/download/$tag"
tmp=$(mktemp -d)
mount=''
cleanup() {
  [ -z "$mount" ] || hdiutil detach "$mount" -quiet 2>/dev/null || true
  rm -rf "$tmp"
}
trap cleanup EXIT

assets="daily-agent-digest-macos-arm64 daily-agent-digest-macos-x86_64 Daily-Agent-Digest-arm64-app.zip Daily-Agent-Digest-x86_64-app.zip Daily-Agent-Digest-arm64.dmg Daily-Agent-Digest-x86_64.dmg install.sh SHA256SUMS"
for asset in $assets; do
  curl -fsSL "$base/$asset" -o "$tmp/$asset"
done

# macOS 没有 GNU 的 sha256sum,这里两种都支持。
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$tmp" && sha256sum -c SHA256SUMS)
else
  (cd "$tmp" && shasum -a 256 -c SHA256SUMS)
fi

# 签名与公证只有 macOS 验得了;在别的系统上跳过,而不是假装通过。
if [ "$(uname -s)" = Darwin ]; then
  for asset in "$tmp"/daily-agent-digest-macos-*; do
    name=$(basename "$asset")
    codesign --verify --deep --strict "$asset" 2>/dev/null || { echo "签名校验失败: $name" >&2; exit 1; }
    codesign -dv --verbose=4 "$asset" 2>&1 | grep -q 'Authority=Developer ID Application:' || { echo "不是 Developer ID 签名: $name" >&2; exit 1; }
    # 裸可执行文件无法装订票据(stapler 不支持),未装订属预期,仅提示。
    xcrun stapler validate "$asset" >/dev/null 2>&1 || echo "注意: $name 无装订票据(裸可执行文件为预期行为)"
  done

  for asset in "$tmp"/Daily-Agent-Digest-*.dmg; do
    name=$(basename "$asset")
    spctl -a -t open --context context:primary-signature -vv "$asset" >/dev/null 2>&1 || {
      echo "DMG 未通过 Gatekeeper 判定: $name" >&2
      spctl -a -t open --context context:primary-signature -vv "$asset" || true
      exit 1
    }
    xcrun stapler validate "$asset" >/dev/null 2>&1 || { echo "DMG 装订票据校验失败: $name" >&2; exit 1; }

    mount=$(mktemp -d)
    hdiutil attach "$asset" -mountpoint "$mount" -nobrowse -quiet
    app=''
    for candidate in "$mount"/*.app; do
      if [ -d "$candidate" ]; then app="$candidate"; break; fi
    done
    [ -n "$app" ] || { echo "DMG 内没有 App: $name" >&2; exit 1; }
    # 用户在 Finder 里双击的就是这个 App:签名有效但被判定为"不是 App"的包会在这里暴露。
    spctl -a -vvv "$app" >/dev/null 2>&1 || {
      echo "DMG 内的 App 未通过 Gatekeeper 判定: $name" >&2
      spctl -a -vvv "$app" || true
      exit 1
    }
    xcrun stapler validate "$app" >/dev/null 2>&1 || { echo "DMG 内 App 的装订票据校验失败: $name" >&2; exit 1; }
    [ -L "$mount/Applications" ] || { echo "DMG 缺少拖拽用的 Applications 快捷方式: $name" >&2; exit 1; }
    # 包内引擎必须是 onedir 目录版:单文件版每次调用都要解包再重新 exec,
    # App 的每个菜单动作都会因此慢上几秒(这正是用户报告的"设置窗口很慢")。
    engine="$app/Contents/Resources/engine/daily-agent-digest"
    [ -x "$engine" ] || { echo "DMG 内的 App 没有包内引擎: $name" >&2; exit 1; }
    [ -d "$(dirname "$engine")/_internal" ] || { echo "包内引擎不是 onedir 布局(会退回每次解包的慢启动): $name" >&2; exit 1; }
    hdiutil detach "$mount" -quiet
    mount=''
  done
fi

grep -q 'LLM_API_KEY' "$tmp/install.sh"
echo "release audit passed: $repo $tag"
