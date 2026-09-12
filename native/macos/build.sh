#!/bin/sh
set -eu
OUT=${1:-build/DailyAgentDigest.app}
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources"
swiftc "$(dirname "$0")/DailyAgentDigest.swift" -o "$OUT/Contents/MacOS/DailyAgentDigest"
cat > "$OUT/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.daily-agent-digest.tray</string><key>CFBundleName</key><string>Daily Agent Digest</string><key>CFBundleExecutable</key><string>DailyAgentDigest</string><key>LSUIElement</key><true/><key>CFBundleVersion</key><string>1</string></dict></plist>
PLIST
