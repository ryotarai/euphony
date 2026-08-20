#!/usr/bin/env bash

set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT

fake_bin="$fixture/bin"
output_dir="$fixture/release"
log_dir="$fixture/log"
mkdir -p "$fake_bin" "$log_dir"

cat >"$fake_bin/npm" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail

printf '%s\t%s\n' "$PWD" "$*" >>"$BUILD_RELEASE_TEST_LOG/npm"
EOF

cat >"$fake_bin/go" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail

output=""
for ((index = 1; index <= $#; index++)); do
  if [[ "${!index}" == "-o" ]]; then
    next=$((index + 1))
    output="${!next}"
    break
  fi
done

printf '%s\t%s\t%s\t%s\n' "$GOOS" "$GOARCH" "$CGO_ENABLED" "$*" >>"$BUILD_RELEASE_TEST_LOG/go"
mkdir -p "$(dirname "$output")"
printf 'test binary %s/%s\n' "$GOOS" "$GOARCH" >"$output"
chmod 755 "$output"
EOF

chmod +x "$fake_bin/npm" "$fake_bin/go"

PATH="$fake_bin:$PATH" \
  BUILD_RELEASE_TEST_LOG="$log_dir" \
  bash "$repo_root/scripts/build_release.sh" "$output_dir"

expected_archives=(
  euphony-linux-amd64.tar.gz
  euphony-linux-arm64.tar.gz
  euphony-macos-amd64.tar.gz
  euphony-macos-arm64.tar.gz
)

for archive in "${expected_archives[@]}"; do
  test -f "$output_dir/$archive"
  tar -tzf "$output_dir/$archive" | grep -Fxq euphony
done

test "$(find "$output_dir" -maxdepth 1 -type f -name '*.tar.gz' | wc -l | tr -d ' ')" -eq 4
test "$(find "$output_dir" -maxdepth 1 -type f ! -name '*.tar.gz' | wc -l | tr -d ' ')" -eq 0

test "$(wc -l <"$log_dir/go" | tr -d ' ')" -eq 4
grep -Fq -- '-trimpath' "$log_dir/go"
grep -Fq -- './cmd/euphony' "$log_dir/go"
for target in \
  $'linux\tamd64\t0' \
  $'linux\tarm64\t0' \
  $'darwin\tamd64\t0' \
  $'darwin\tarm64\t0'; do
  grep -Fq "$target" "$log_dir/go"
done

grep -Fq $'\tci' "$log_dir/npm"
grep -Fq $'\trun build' "${log_dir}/npm"

echo "release build packaging passed"
