#!/bin/sh
set -eu
repo=${1:-mzlc-linmo/daily-agent-digest}
tag=${2:?usage: release-audit.sh REPO TAG}
base="https://github.com/$repo/releases/download/$tag"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
for asset in daily-agent-digest-macos-arm64 daily-agent-digest-macos-x86_64 Daily-Agent-Digest-arm64-app.zip Daily-Agent-Digest-x86_64-app.zip install.sh SHA256SUMS; do
  curl -fsSL "$base/$asset" -o "$tmp/$asset"
done
(cd "$tmp" && sha256sum -c SHA256SUMS)
grep -q 'LLM_API_KEY' "$tmp/install.sh"
echo "release audit passed: $repo $tag"
