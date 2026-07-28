# Euphony

Euphony is a browser workspace for terminal-based coding agents. It runs real
local PTY sessions, streams them over authenticated WebSockets, and provides
desktop and mobile terminal navigation.

## Requirements

- Go 1.24 or newer
- Node.js 22 or newer
- npm 10 or newer
- macOS or Linux

## Build

```sh
make build
```

The command produces `bin/euphony`. The executable contains the complete
frontend; Node.js is not needed at runtime.

## Run

Choose a strong access token and start the server:

```sh
EUPHONY_TOKEN='replace-with-a-long-random-token' bin/euphony
```

Open <http://127.0.0.1:8080> and enter the same token. The default listen
address can be changed:

```sh
EUPHONY_TOKEN='replace-with-a-long-random-token' \
EUPHONY_ADDR='0.0.0.0:8080' \
bin/euphony
```

Euphony does not terminate TLS. When the server is reachable outside a trusted
network, place it behind an HTTPS reverse proxy and restrict network access.

The token is stored in the browser's `sessionStorage`. Terminal WebSockets use
single-use tickets instead of placing the long-lived token in their URLs.
When the authenticated workspace has no terminals, Euphony starts and selects
one terminal automatically.

## Coding agent setup

Install hooks for supported coding agents found on `PATH`:

```sh
euphony setup
```

The command currently detects Codex and Claude Code. It preserves existing
hooks, can be run repeatedly without adding duplicates, and enables Codex's
lifecycle hook feature. It respects `CODEX_HOME` and `CLAUDE_CONFIG_DIR`.
Agents started inside an Euphony terminal inherit the terminal identifier,
hook endpoint, and authentication token used by the installed hooks.

## Development

Start the Go API and Vite development server together:

```sh
make dev
```

The command opens <http://127.0.0.1:5173> in the default browser and signs in
with `development-token`. The token is removed from the address bar
immediately after the page consumes it. The command installs frontend
dependencies when needed, waits for the API to become healthy, and stops both
processes when you press Ctrl+C.

The development settings can be overridden:

```sh
EUPHONY_TOKEN=custom-token \
EUPHONY_ADDR=127.0.0.1:19090 \
EUPHONY_DEV_API_URL=http://127.0.0.1:19090 \
EUPHONY_DEV_HOST=0.0.0.0 \
EUPHONY_DEV_PORT=5199 \
make dev
```

Vite proxies `/api` requests and WebSockets to the configured API URL.

## Agent hooks

Every Euphony terminal receives these environment variables:

- `EUPHONY_TERMINAL_ID`: the terminal associated with the agent process
- `EUPHONY_HOOK_URL`: the endpoint that accepts agent activity
- `EUPHONY_TOKEN`: the bearer token for that endpoint

Codex, Claude Code, or a wrapper script can report hook events with:

```sh
curl --fail --silent \
  -H "Authorization: Bearer $EUPHONY_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"terminalId\":\"$EUPHONY_TERMINAL_ID\",\"agent\":\"codex\",\"status\":\"running\",\"title\":\"Implement terminal groups\",\"cwd\":\"$PWD\"}" \
  "$EUPHONY_HOOK_URL"
```

Use the agent's start, stop, notification, and session-title hooks to send the
corresponding status and title. The sidebar refreshes activity automatically.

Run all automated checks with:

```sh
make test
```

## Current boundaries

Sessions live in server memory and do not survive a server restart. Browser
disconnects do not terminate their PTY processes. Multi-user accounts and file
management are not implemented.
