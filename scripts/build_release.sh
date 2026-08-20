#!/usr/bin/env bash

set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output_dir="${1:-$repo_root/dist/release}"
if [[ "$output_dir" != /* ]]; then
  output_dir="$(pwd)/$output_dir"
fi

mkdir -p "$output_dir"

staging_dir="$(mktemp -d)"
trap 'rm -rf "$staging_dir"' EXIT

pushd "$repo_root/web" >/dev/null
npm ci
npm run build
popd >/dev/null

targets=(
  "linux amd64 euphony-linux-amd64"
  "linux arm64 euphony-linux-arm64"
  "darwin amd64 euphony-macos-amd64"
  "darwin arm64 euphony-macos-arm64"
)

pushd "$repo_root" >/dev/null
for target in "${targets[@]}"; do
  read -r goos goarch asset_name <<<"$target"
  binary_dir="$staging_dir/$asset_name"
  binary_path="$binary_dir/euphony"
  archive_path="$output_dir/$asset_name.tar.gz"

  mkdir -p "$binary_dir"
  rm -f "$archive_path"
  CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
    go build -trimpath -o "$binary_path" ./cmd/euphony
  tar -C "$binary_dir" -czf "$archive_path" euphony
  printf 'Built %s\n' "$archive_path"
done
popd >/dev/null
