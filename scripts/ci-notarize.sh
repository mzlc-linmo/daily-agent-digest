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

# ---- DMG:制作 → 签名 → 公证 → 装订 → 端到端挂载校验 -------------------------
# 全部在 macOS 作业里做(release 作业是 Linux,没有 hdiutil / codesign / stapler)。
dmg="dist/Daily-Agent-Digest-$BUILD_ARCH.dmg"
if [ -d "$app_path" ]; then
  stage="$RUNNER_TEMP/dmg-stage-$BUILD_ARCH"
  rm -rf "$stage" "$dmg"
  mkdir -p "$stage"
  cp -R "$app_path" "$stage/"
  ln -s /Applications "$stage/Applications"
  hdiutil create -volname 'Daily Agent Digest' -srcfolder "$stage" -ov -format UDZO "$dmg" >/dev/null
  echo "Built $(basename "$dmg")"
  codesign --force --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$dmg"
  echo 'Submitting DMG to Apple (no wait)'
  xcrun notarytool submit "$dmg" "${auth[@]}" --no-wait --output-format json > "$metadata/dmg-submission.json"
  dmg_sid=$(python -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$metadata/dmg-submission.json")
  printf 'DMG notarization submission: %s\n' "$dmg_sid"
  xcrun notarytool wait "$dmg_sid" "${auth[@]}" --timeout 20m || true
  xcrun notarytool info "$dmg_sid" "${auth[@]}" --output-format json > "$metadata/dmg-status.json"
  dmg_status=$(python -c 'import json,sys; print(json.load(open(sys.argv[1]))["status"])' "$metadata/dmg-status.json")
  printf 'DMG notarization status: %s\n' "$dmg_status"
  if [ "$dmg_status" != 'Accepted' ]; then
    xcrun notarytool log "$dmg_sid" "${auth[@]}" "$metadata/dmg-log.json" 2>/dev/null || true
    cat "$metadata/dmg-log.json" 2>/dev/null || true
    exit 1
  fi
  xcrun stapler staple "$dmg"
  xcrun stapler validate "$dmg"

  # 端到端校验:挂载后确认里面的 App 已签名+公证装订、Applications 链接存在
  mount_point=$(mktemp -d)
  hdiutil attach "$dmg" -mountpoint "$mount_point" -nobrowse -quiet
  embedded_app=$(find "$mount_point" -maxdepth 1 -name '*.app' | head -1)
  test -n "$embedded_app"
  codesign --verify --deep --strict "$embedded_app"
  xcrun stapler validate "$embedded_app"
  [ -L "$mount_point/Applications" ] || { echo 'DMG 缺少 Applications 快捷方式' >&2; exit 1; }
  hdiutil detach "$mount_point" -quiet
  echo 'DMG signed, notarized, stapled and verified'
else
  echo "App bundle not found, skipping DMG"
fi
