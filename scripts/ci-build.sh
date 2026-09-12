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
  for required in APPLE_CERTIFICATE_BASE64 APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY APPLE_ID APPLE_APP_PASSWORD APPLE_TEAM_ID; do
    if [ -z "${!required:-}" ]; then echo "Missing required signing secret: $required" >&2; exit 1; fi
  done
  keychain="$RUNNER_TEMP/digest-signing.keychain-db"
  keychain_password=$(openssl rand -hex 24)
  printf '%s' "$APPLE_CERTIFICATE_BASE64" | base64 --decode > "$RUNNER_TEMP/digest-certificate.p12"
  security create-keychain -p "$keychain_password" "$keychain"
  security set-keychain-settings -lut 21600 "$keychain"
  security unlock-keychain -p "$keychain_password" "$keychain"
  security import "$RUNNER_TEMP/digest-certificate.p12" -P "$APPLE_CERTIFICATE_PASSWORD" -A -t cert -f pkcs12 -k "$keychain"
  security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain"
  security list-keychains -d user -s "$keychain"
  security default-keychain -s "$keychain"
fi
pyinstaller "${build_args[@]}" daily_agent_digest.py
binary="dist/$asset"
if [ "$SIGN_RELEASE" = true ]; then
  codesign --force --options runtime --timestamp --sign "$APPLE_SIGNING_IDENTITY" --keychain "$keychain" "$binary"
fi
"$binary" --help
# Exercise the CLI against empty input without sending any real logs.
env -u LLM_BASE_URL -u LLM_API_KEY -u LLM_MODEL "$binary" --date 2026-09-11 --root "$RUNNER_TEMP/empty-digest-source" --out "$RUNNER_TEMP/digest-smoke.json"
python -c 'import json,sys; assert json.load(open(sys.argv[1]))["coverage"]["events"] == 0' "$RUNNER_TEMP/digest-smoke.json"
if [ "$SIGN_RELEASE" = true ]; then
  codesign --verify --strict --verbose=2 "$binary"
  codesign -dvv "$binary" 2>&1 | grep -q 'Authority=Developer ID Application:'
  ditto -c -k --keepParent "$binary" "$RUNNER_TEMP/$asset.zip"
  xcrun notarytool submit "$RUNNER_TEMP/$asset.zip" --apple-id "$APPLE_ID" --password "$APPLE_APP_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait --output-format json > "$RUNNER_TEMP/notarization.json"
  python -c 'import json,sys; assert json.load(open(sys.argv[1]))["status"] == "Accepted"' "$RUNNER_TEMP/notarization.json"
fi
