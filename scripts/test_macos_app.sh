#!/usr/bin/env bash

set -Eeuo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
	printf 'test-macos requires macOS.\n' >&2
	exit 1
fi

if ! command -v swiftc >/dev/null 2>&1; then
	printf 'swiftc is required. Install the Xcode Command Line Tools.\n' >&2
	exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
module_cache_dir="$(mktemp -d /tmp/euphony-swift-modules.XXXXXX)"
trap 'rm -rf "$module_cache_dir"' EXIT

swiftc \
	-module-cache-path "$module_cache_dir" \
	"$repo_root/macos/LaunchConfiguration.swift" \
	"$repo_root/macos/LaunchConfigurationTests.swift" \
	-o "$module_cache_dir/launch-configuration-tests"
"$module_cache_dir/launch-configuration-tests"

swiftc \
	-module-cache-path "$module_cache_dir" \
	-typecheck \
	-framework AppKit \
	-framework WebKit \
	"$repo_root/macos/LaunchConfiguration.swift" \
	"$repo_root/macos/EuphonyApp.swift"

printf 'macOS Swift checks passed\n'
