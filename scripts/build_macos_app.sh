#!/usr/bin/env bash

set -Eeuo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
	printf 'macos-app requires macOS.\n' >&2
	exit 1
fi

if ! command -v swiftc >/dev/null 2>&1; then
	printf 'swiftc is required. Install the Xcode Command Line Tools.\n' >&2
	exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app_path="$repo_root/bin/Euphony.app"
mkdir -p "$repo_root/bin"
module_cache_dir="$(mktemp -d /tmp/euphony-swift-build.XXXXXX)"
stage_path="$(mktemp -d "$repo_root/bin/.Euphony.app.XXXXXX")"

cleanup() {
	rm -rf "$module_cache_dir" "$stage_path"
}
trap cleanup EXIT

mkdir -p "$stage_path/Contents/MacOS" "$stage_path/Contents/Resources"

pushd "$repo_root/web" >/dev/null
npm ci
npm run build
popd >/dev/null

go build \
	-trimpath \
	-o "$stage_path/Contents/Resources/euphony-server" \
	"$repo_root/cmd/euphony"

swiftc \
	-module-cache-path "$module_cache_dir" \
	-O \
	-framework AppKit \
	-framework WebKit \
	"$repo_root/macos/LaunchConfiguration.swift" \
	"$repo_root/macos/FileDropBridge.swift" \
	"$repo_root/macos/EuphonyApp.swift" \
	-o "$stage_path/Contents/MacOS/Euphony"

cp "$repo_root/macos/Info.plist" "$stage_path/Contents/Info.plist"
chmod 755 \
	"$stage_path/Contents/MacOS/Euphony" \
	"$stage_path/Contents/Resources/euphony-server"

rm -rf "$app_path"
mv "$stage_path" "$app_path"
printf 'Built %s\n' "$app_path"
