#!/bin/bash
set -euo pipefail
asset="daily-agent-digest-macos-$BUILD_ARCH"
metadata="$RUNNER_TEMP/notarization-$BUILD_ARCH"
mkdir -p "$metadata"
auth=(--apple-id "$APPLE_ID" --password "$APPLE_APP_PASSWORD" --team-id "$APPLE_TEAM_ID")
ditto -c -k --keepParent "dist/$asset" "$RUNNER_TEMP/$asset.zip"

echo 'Submitting signed archive to Apple (no wait)'
xcrun notarytool submit "$RUNNER_TEMP/$asset.zip" "${auth[@]}" --no-wait --output-format json > "$metadata/submission.json"
submission_id=$(python -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$metadata/submission.json")
printf 'Apple notarization submission: %s\n' "$submission_id"
printf '### Apple notarization (%s)\n\nSubmission: `%s`\n' "$BUILD_ARCH" "$submission_id" >> "$GITHUB_STEP_SUMMARY"

echo 'Waiting for Apple processing (maximum 20 minutes; submission survives timeout)'
xcrun notarytool wait "$submission_id" "${auth[@]}" --timeout 20m || true
xcrun notarytool info "$submission_id" "${auth[@]}" --output-format json > "$metadata/status.json"
status=$(python -c 'import json,sys; print(json.load(open(sys.argv[1]))["status"])' "$metadata/status.json")
printf 'Apple notarization status: %s\n' "$status"
printf '\nStatus: **%s**\n' "$status" >> "$GITHUB_STEP_SUMMARY"
if [ "$status" != 'Accepted' ]; then
  if [ "$status" = 'Invalid' ] || [ "$status" = 'Rejected' ]; then
    xcrun notarytool log "$submission_id" "${auth[@]}" "$metadata/log.json"
    cat "$metadata/log.json"
  else
    echo 'Apple is still processing. Preserve this submission and binary; do not repeatedly resubmit.'
  fi
  exit 1
fi

# ---- App 包也要公证 ---------------------------------------------------------
# 此前只有引擎二进制走了公证,App 包仅签名 —— 别人下载后在非构建机器上会被 Gatekeeper 拦。
# 这里只做 App 公证(不含任何 DMG 逻辑),改动面最小、便于单独验证。
app_path="dist/Daily Agent Digest $BUILD_ARCH.app"
if [ -d "$app_path" ]; then
  app_zip="$RUNNER_TEMP/app-$BUILD_ARCH.zip"
  rm -f "$app_zip"
  ditto -c -k --keepParent "$app_path" "$app_zip"
  echo 'Submitting app bundle to Apple (no wait)'
  xcrun notarytool submit "$app_zip" "${auth[@]}" --no-wait --output-format json > "$metadata/app-submission.json"
  app_sid=$(python -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$metadata/app-submission.json")
  printf 'App notarization submission: %s\n' "$app_sid"
  xcrun notarytool wait "$app_sid" "${auth[@]}" --timeout 20m || true
  xcrun notarytool info "$app_sid" "${auth[@]}" --output-format json > "$metadata/app-status.json"
  app_status=$(python -c 'import json,sys; print(json.load(open(sys.argv[1]))["status"])' "$metadata/app-status.json")
  printf 'App notarization status: %s\n' "$app_status"
  if [ "$app_status" != 'Accepted' ]; then
    xcrun notarytool log "$app_sid" "${auth[@]}" "$metadata/app-log.json" 2>/dev/null || true
    cat "$metadata/app-log.json" 2>/dev/null || true
    exit 1
  fi
  xcrun stapler staple "$app_path"
  xcrun stapler validate "$app_path"
  echo 'App bundle notarized and stapled'
else
  echo "App bundle not found at $app_path, skipping notarization"
fi
