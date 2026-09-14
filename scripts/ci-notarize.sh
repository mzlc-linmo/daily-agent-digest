#!/bin/bash
set -euo pipefail
asset="daily-agent-digest-macos-$BUILD_ARCH"
metadata="$RUNNER_TEMP/notarization-$BUILD_ARCH"
mkdir -p "$metadata"
auth=(--apple-id "$APPLE_ID" --password "$APPLE_APP_PASSWORD" --team-id "$APPLE_TEAM_ID")

# 签名 DMG 需要 Developer ID 身份与私钥。这一步此前只拿到公证凭据,拿不到签名身份,
# 所以在这里自建临时钥匙串并导入证书 —— 不依赖上一步残留的状态(它退出时会清理)。
keychain=""
cleanup_keychain() {
  if [ -n "$keychain" ]; then security delete-keychain "$keychain" || true; fi
  rm -f "$RUNNER_TEMP/notarize-certificate.p12"
}
trap cleanup_keychain EXIT
# 只按 SIGN_RELEASE 判断:缺少签名密钥时下面的必填校验会明确报错退出,
# 而不是被这个条件悄悄跳过、最后表现成"DMG 没做出来"。
if [ "${SIGN_RELEASE:-false}" = true ]; then
  echo 'Importing Developer ID certificate for signing'
  for required in APPLE_CERTIFICATE_BASE64 APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY; do
    if [ -z "${!required:-}" ]; then echo "Missing required signing secret: $required" >&2; exit 1; fi
  done
  keychain="$RUNNER_TEMP/notarize-signing.keychain-db"
  keychain_password=$(openssl rand -hex 24)
  printf '%s' "$APPLE_CERTIFICATE_BASE64" | base64 --decode > "$RUNNER_TEMP/notarize-certificate.p12"
  security create-keychain -p "$keychain_password" "$keychain"
  security set-keychain-settings -lut 21600 "$keychain"
  security unlock-keychain -p "$keychain_password" "$keychain"
  security import "$RUNNER_TEMP/notarize-certificate.p12" -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security -t cert -f pkcs12 -k "$keychain"
  security set-key-partition-list -S apple-tool:,apple: -s -k "$keychain_password" "$keychain"
  security find-identity -v -p codesigning "$keychain" | grep -Fq "$APPLE_SIGNING_IDENTITY"
  security list-keychains -d user -s "$keychain"
  security default-keychain -s "$keychain"
  echo 'Signing identity available'
fi
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

# ---- DMG:制作 → 签名 → 公证 → 装订 → 挂载校验 -------------------------------
# 放在 App 公证之后:DMG 里装的是已经公证并装订过的 App。
if [ "${SIGN_RELEASE:-false}" = true ] && [ -d "$app_path" ]; then
  dmg="dist/Daily-Agent-Digest-$BUILD_ARCH.dmg"
  stage="$RUNNER_TEMP/dmg-stage-$BUILD_ARCH"
  rm -rf "$stage" "$dmg"
  mkdir -p "$stage"
  # 用 ditto 而不是 cp -R:它保证扩展属性(装订票据就存在那里)随 bundle 一起复制,
  # 否则 DMG 里的 App 会丢掉 staple,用户离线打开时仍会被 Gatekeeper 拦。
  ditto "$app_path" "$stage/$(basename "$app_path")"
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

  # 端到端校验:按用户实际接触它的方式验证 —— 挂载、检查内部 App 的签名与装订、确认拖拽入口
  mount_point=$(mktemp -d)
  hdiutil attach "$dmg" -mountpoint "$mount_point" -nobrowse -quiet
  embedded_app=''
  for candidate in "$mount_point"/*.app; do
    if [ -d "$candidate" ]; then embedded_app="$candidate"; break; fi
  done
  test -n "$embedded_app"
  codesign --verify --deep --strict "$embedded_app"
  xcrun stapler validate "$embedded_app"
  [ -L "$mount_point/Applications" ] || { echo 'DMG 缺少 Applications 快捷方式' >&2; exit 1; }
  hdiutil detach "$mount_point" -quiet
  echo 'DMG signed, notarized, stapled and verified'
else
  # 静默跳过曾经导致整轮 CI 白跑:签名发布却没做 DMG,必须直接失败而不是继续。
  if [ "${SIGN_RELEASE:-false}" = true ]; then
    echo "SIGN_RELEASE=true 但没有可打包的 App 包($app_path),无法制作 DMG" >&2
    exit 1
  fi
  echo 'Skipping DMG (unsigned build)'
fi
