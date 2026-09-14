#!/bin/bash
set -euo pipefail
test "$(uname -m)" = "$BUILD_ARCH"
asset="daily-agent-digest-macos-$BUILD_ARCH"
build_args=(--target-architecture "$BUILD_ARCH")
keychain=""
cleanup() {
  if [ -n "$keychain" ]; then security delete-keychain "$keychain" || true; fi
  rm -f "$RUNNER_TEMP/digest-certificate.p12"
}
trap cleanup EXIT
if [ "$SIGN_RELEASE" = true ]; then
  echo 'Importing Developer ID certificate'
  for required in APPLE_CERTIFICATE_BASE64 APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY APPLE_ID APPLE_APP_PASSWORD APPLE_TEAM_ID; do
    if [ -z "${!required:-}" ]; then echo "Missing required signing secret: $required" >&2; exit 1; fi
  done
  keychain="$RUNNER_TEMP/digest-signing.keychain-db"
  keychain_password=$(openssl rand -hex 24)
  printf '%s' "$APPLE_CERTIFICATE_BASE64" | base64 --decode > "$RUNNER_TEMP/digest-certificate.p12"
  security create-keychain -p "$keychain_password" "$keychain"
  security set-keychain-settings -lut 21600 "$keychain"
  security unlock-keychain -p "$keychain_password" "$keychain"
  security import "$RUNNER_TEMP/digest-certificate.p12" -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security -t cert -f pkcs12 -k "$keychain"
  security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain"
  security find-identity -v -p codesigning "$keychain" | grep -Fq "$APPLE_SIGNING_IDENTITY"
  security list-keychains -d user -s "$keychain"
  security default-keychain -s "$keychain"
  # Sign the embedded Python libraries as well as the outer executable.
  build_args+=(--codesign-identity "$APPLE_SIGNING_IDENTITY")
fi

# 两次 PyInstaller 构建必须各用独立的 workpath/specpath,否则第二次会撞上第一次的
# 中间产物目录和同名 .spec。
echo 'Building the standalone onefile binary'
rm -rf "dist/$asset"
pyinstaller --onefile --name "$asset" \
  --distpath dist --workpath "$RUNNER_TEMP/onefile-work-$BUILD_ARCH" --specpath "$RUNNER_TEMP/onefile-spec-$BUILD_ARCH" \
  "${build_args[@]}" daily_agent_digest.py
binary="dist/$asset"
# Build the native menu-bar controller alongside the engine on macOS.
if [ -f native/macos/build.sh ]; then
  native_app="dist/Daily Agent Digest $BUILD_ARCH.app"
  # App 包内的引擎用 onedir:onefile 每次调用都要把内容解包到临时目录再重新 exec 自己
  # (实测单次启动 3-6 秒,而 App 的每个菜单动作都要新起一个进程),onedir 启动约 0.03-0.3 秒。
  # 发布页上的单文件二进制保持 onefile —— install.sh 的定时任务一天只跑一次,不受影响。
  echo 'Building the onedir engine that ships inside the app bundle'
  engine_name="daily-agent-digest"
  rm -rf "dist/engine-$BUILD_ARCH"
  pyinstaller --onedir --name "$engine_name" \
    --distpath "dist/engine-$BUILD_ARCH" --workpath "$RUNNER_TEMP/onedir-work-$BUILD_ARCH" --specpath "$RUNNER_TEMP/onedir-spec-$BUILD_ARCH" \
    "${build_args[@]}" daily_agent_digest.py
  bash native/macos/build.sh "$native_app"
  mkdir -p "$native_app/Contents/Resources/engine"
  ditto "dist/engine-$BUILD_ARCH/$engine_name" "$native_app/Contents/Resources/engine"
  test -x "$native_app/Contents/Resources/engine/$engine_name"
  # 断言 App 真的会选包内 onedir 引擎:解析失败/退回旧布局就意味着启动又变成秒级。
  reported_engine=$("$native_app/Contents/MacOS/DailyAgentDigest" --engine-path || true)
  case "$reported_engine" in
    */Contents/Resources/engine/daily-agent-digest) echo "bundled engine resolved: $reported_engine" ;;
    *) echo "App 没有解析到包内 onedir 引擎:$reported_engine" >&2; exit 1 ;;
  esac
  if [ "$SIGN_RELEASE" = true ]; then
    echo "Signing native App bundle"
    # 公证会逐个检查包内每个 Mach-O(.so/.dylib 也算),漏签一个整包就会被拒,
    # 所以这里不依赖 PyInstaller 的签名,把引擎目录里的 Mach-O 全部补签一遍。
    while IFS= read -r -d '' item; do
      if file -b "$item" | grep -q 'Mach-O'; then
        codesign --force --options runtime --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$item"
      fi
    done < <(find "$native_app/Contents/Resources/engine" -type f -print0)
    codesign --force --options runtime --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$native_app/Contents/MacOS/DailyAgentDigest"
    codesign --force --options runtime --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$native_app"
    codesign --verify --deep --strict --verbose=2 "$native_app"
    codesign -dv --verbose=4 "$native_app" 2>&1 | grep -Fq 'Authority=Developer ID Application:'
    echo 'Native App Developer ID signature verified'
  fi
  echo 'Build provenance'
  echo "git_commit=$(git rev-parse HEAD)"
  echo "swift_source_sha256=$(shasum -a 256 native/macos/DailyAgentDigest.swift | awk '{print $1}')"
  echo "ui_binary_sha256=$(shasum -a 256 "$native_app/Contents/MacOS/DailyAgentDigest" | awk '{print $1}')"
  # 包内引擎的启动开销取决于它是 onefile 还是 onedir,把结论留在日志里便于回归。
  engine_time=$( { echo '{}' | /usr/bin/time -p "$native_app/Contents/Resources/engine/$engine_name" --app-command state >/dev/null; } 2>&1 | awk '/^real/{print $2}' || true)
  echo "bundled_engine_command_seconds=${engine_time:-unknown}"
  echo "bundled_engine_layout=onedir"
  plutil -p "$native_app/Contents/Info.plist"
  ditto -c -k --keepParent "$native_app" "dist/Daily-Agent-Digest-$BUILD_ARCH-app.zip"
fi
echo 'Running executable smoke tests'
"$binary" --help
# Exercise the CLI against empty input without sending any real logs.
env -u LLM_BASE_URL -u LLM_API_KEY -u LLM_MODEL "$binary" --date 2026-09-11 --root "$RUNNER_TEMP/empty-digest-source" --out "$RUNNER_TEMP/digest-smoke.json"
python -c 'import json,sys; assert json.load(open(sys.argv[1]))["coverage"]["events"] == 0' "$RUNNER_TEMP/digest-smoke.json"
if [ "$SIGN_RELEASE" = true ]; then
  codesign --verify --strict --verbose=2 "$binary"
  codesign -dvv "$binary" 2>&1 | grep -q 'Authority=Developer ID Application:'
  echo 'Developer ID signature verified'
fi
