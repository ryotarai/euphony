#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT

mkdir -p "$fixture/repo/scripts" "$fixture/repo/web" "$fixture/bin"
cp "$repo_root/scripts/dev.sh" "$fixture/repo/scripts/dev.sh"

cat >"$fixture/bin/go" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'token=%s\naddr=%s\nsocket=%s\nargs=%s\n' "$EUPHONY_TOKEN" "$EUPHONY_ADDR" "$EUPHONY_SOCKET" "$*" >"$DEV_TEST_LOG/go-started"
trap 'printf "stopped\n" >"$DEV_TEST_LOG/go-stopped"; exit 0' TERM INT
while true; do sleep 0.05; done
EOF

cat >"$fixture/bin/npm" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "install" ]]; then
  mkdir -p node_modules
  printf 'installed\n' >"$DEV_TEST_LOG/npm-installed"
  exit 0
fi
printf 'api_url=%s\nargs=%s\n' "$EUPHONY_DEV_API_URL" "$*" >"$DEV_TEST_LOG/vite-started"
kill -TERM "$PPID"
EOF

cat >"$fixture/bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ -f "$DEV_TEST_LOG/go-started" ]]
EOF

chmod +x "$fixture/bin/go" "$fixture/bin/npm" "$fixture/bin/curl" "$fixture/repo/scripts/dev.sh"
mkdir -p "$fixture/log"

set +e
PATH="$fixture/bin:$PATH" \
  DEV_TEST_LOG="$fixture/log" \
  EUPHONY_TOKEN="custom-token" \
  EUPHONY_ADDR="127.0.0.1:19090" \
  EUPHONY_DEV_HOST="0.0.0.0" \
  EUPHONY_DEV_PORT="5199" \
  "$fixture/repo/scripts/dev.sh"
status=$?
set -e

if [[ $status -eq 0 ]]; then
  echo "dev.sh unexpectedly exited successfully after TERM" >&2
  exit 1
fi

grep -q '^token=custom-token$' "$fixture/log/go-started"
grep -q '^addr=127.0.0.1:19090$' "$fixture/log/go-started"
grep -q "^socket=$fixture/repo/tmp/euphony-dev-5199.sock$" "$fixture/log/go-started"
grep -q '^args=run ./cmd/euphony$' "$fixture/log/go-started"
grep -q '^installed$' "$fixture/log/npm-installed"
grep -q '^api_url=http://127.0.0.1:19090$' "$fixture/log/vite-started"
grep -q '^args=run dev -- --host 0.0.0.0 --port 5199 --open /?token=custom-token$' "$fixture/log/vite-started"
grep -q '^stopped$' "$fixture/log/go-stopped"

echo "dev process orchestration passed"
