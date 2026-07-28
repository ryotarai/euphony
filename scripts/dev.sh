#!/usr/bin/env bash

set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
token="${EUPHONY_TOKEN:-development-token}"
api_address="${EUPHONY_ADDR:-127.0.0.1:8080}"
api_url="${EUPHONY_DEV_API_URL:-http://$api_address}"
vite_host="${EUPHONY_DEV_HOST:-127.0.0.1}"
vite_port="${EUPHONY_DEV_PORT:-5173}"
api_pid=""

cleanup() {
  trap - EXIT
  if [[ -n "$api_pid" ]] && kill -0 "$api_pid" 2>/dev/null; then
    kill -TERM "$api_pid" 2>/dev/null || true
    wait "$api_pid" 2>/dev/null || true
  fi
}

shutdown() {
  exit 130
}

trap cleanup EXIT
trap shutdown INT TERM

if [[ ! -d "$repo_root/web/node_modules" ]]; then
  (
    cd "$repo_root/web"
    npm install
  )
fi

echo "Starting Euphony API at http://$api_address"
(
  cd "$repo_root"
  export EUPHONY_TOKEN="$token"
  export EUPHONY_ADDR="$api_address"
  exec go run ./cmd/euphony
) &
api_pid=$!

for _ in {1..100}; do
  if curl --fail --silent --output /dev/null "$api_url/api/health"; then
    break
  fi
  if ! kill -0 "$api_pid" 2>/dev/null; then
    echo "Euphony API exited before becoming ready." >&2
    exit 1
  fi
  sleep 0.05
done
if ! curl --fail --silent --output /dev/null "$api_url/api/health"; then
  echo "Euphony API did not become ready at $api_url." >&2
  exit 1
fi

encoded_token="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$token")"
echo "Starting Euphony web UI at http://$vite_host:$vite_port"
cd "$repo_root/web"
export EUPHONY_DEV_API_URL="$api_url"
npm run dev -- --host "$vite_host" --port "$vite_port" --open "/?token=$encoded_token"
