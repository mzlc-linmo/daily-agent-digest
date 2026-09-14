#!/bin/bash
set -euo pipefail
test "$(uname -m)" = "$BUILD_ARCH"
asset="daily-agent-digest-macos-$BUILD_ARCH"
build_args=(--onefile --name "$asset" --target-architecture "$BUILD_ARCH")
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

echo 'Building executable and embedded libraries'
pyinstaller "${build_args[@]}" daily_agent_digest.py
binary="dist/$asset"
# Build the native menu-bar controller alongside the engine on macOS.
if [ -f native/macos/build.sh ]; then
  native_app="dist/Daily Agent Digest $BUILD_ARCH.app"
  bash native/macos/build.sh "$native_app"
  cp "$binary" "$native_app/Contents/MacOS/daily-agent-digest"
  if [ "$SIGN_RELEASE" = true ]; then
    echo "Signing native App bundle"
    codesign --force --options runtime --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$native_app/Contents/MacOS/daily-agent-digest"
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
