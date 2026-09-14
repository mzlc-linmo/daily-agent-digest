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
