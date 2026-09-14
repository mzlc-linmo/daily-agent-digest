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

# ---- App 包与 DMG 同样要公证 -------------------------------------------------
# 此前只有引擎二进制走了公证,App 包只签名未公证 —— 别人下载后 Gatekeeper 会拦。
notarize_and_staple() {
  local target="$1" label="$2" submit_path
  if [ ! -e "$target" ]; then echo "skip $label (not built)"; return 0; fi
  case "$target" in
    *.dmg) submit_path="$target" ;;                 # notarytool 直接接受 dmg
    *)     submit_path="$RUNNER_TEMP/$label.zip"
           rm -f "$submit_path"; ditto -c -k --keepParent "$target" "$submit_path" ;;
  esac
  echo "Submitting $label to Apple"
  xcrun notarytool submit "$submit_path" "${auth[@]}" --no-wait --output-format json > "$metadata/$label.json"
  local sid status
  sid=$(python -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$metadata/$label.json")
  printf '### Apple notarization (%s)\n\nSubmission: `%s`\n' "$label" "$sid" >> "$GITHUB_STEP_SUMMARY"
  xcrun notarytool wait "$sid" "${auth[@]}" --timeout 20m || true
  xcrun notarytool info "$sid" "${auth[@]}" --output-format json > "$metadata/$label-status.json"
  status=$(python -c 'import json,sys; print(json.load(open(sys.argv[1]))["status"])' "$metadata/$label-status.json")
  printf 'Apple notarization status (%s): %s\n' "$label" "$status"
  if [ "$status" != 'Accepted' ]; then
    xcrun notarytool log "$sid" "${auth[@]}" "$metadata/$label-log.json" 2>/dev/null || true
    cat "$metadata/$label-log.json" 2>/dev/null || true
    exit 1
  fi
  xcrun stapler staple "$target"
  xcrun stapler validate "$target"
  echo "$label notarized and stapled"
}

notarize_and_staple "dist/Daily Agent Digest $BUILD_ARCH.app" "app-$BUILD_ARCH"
notarize_and_staple "dist/Daily-Agent-Digest-$BUILD_ARCH.dmg" "dmg-$BUILD_ARCH"
