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

Start the server:

```sh
bin/euphony
```

When `EUPHONY_TOKEN` is unset, Euphony generates a secure token and opens the
authenticated local URL in your default browser. The token is removed from the
address bar as soon as the page loads. To provide your own token or change the
listen address:

```sh
EUPHONY_TOKEN='replace-with-a-long-random-token' \
EUPHONY_ADDR='0.0.0.0:8080' \
bin/euphony
```

Euphony does not terminate TLS. When the server is reachable outside a trusted
network, place it behind an HTTPS reverse proxy and restrict network access.

The server also exposes the same automation API on a private Unix socket. Its
path is resolved from `EUPHONY_SOCKET`, then
`$XDG_RUNTIME_DIR/euphony/euphony.sock`, then
`~/.local/euphony/euphony.sock`. The socket is created with mode `0600`.

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

## Automation API and CLI

The `euphony` executable includes a versioned JSON API and a scripting CLI for
terminals, Codex and Claude sessions, and the browser's shared pane selection.
The CLI uses the local Unix socket by default:

```sh
euphony status
euphony terminal create --name Build --cwd "$PWD" --selection replace
euphony terminal run TERMINAL_ID 'go test ./...'
euphony terminal wait-output --match PASS --timeout 30000 TERMINAL_ID
euphony agent prompt --wait --until waiting TERMINAL_ID 'Fix the failing test'
euphony selection get
```

Use `--url` and `--token` for TCP instead:

```sh
euphony --url http://127.0.0.1:8080 --token "$EUPHONY_TOKEN" terminal list
```

Finite commands return stable JSON success or error envelopes. Successful
output is written to stdout with exit status 0. API errors are written to
stderr with exit status 1; CLI usage errors use exit status 2. Event and
terminal observation commands emit newline-delimited JSON.

The OpenAPI 3.1 schema is bundled with the server:

```sh
euphony api schema
curl -H "Authorization: Bearer $EUPHONY_TOKEN" \
  http://127.0.0.1:8080/api/v1/schema
```

See [Automation API and CLI](docs/automation.md) for the complete command and
transport reference.

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

Claude Code hook payloads carry no session title, so `euphony hook claude` reads
the newest `ai-title` entry from the `transcript_path` the hook reports. Codex
titles come from `~/.codex/session_index.jsonl` instead.

## Persistence

Euphony stores terminal metadata in SQLite at
`~/.local/euphony/euphony.sqlite3`. Set `EUPHONY_DB` to use a different path:

```sh
EUPHONY_DB=/path/to/euphony.sqlite3 make dev
```

After Euphony restarts, terminal processes are recreated in their saved working
directories. Codex and Claude Code sessions are resumed automatically when
their hooks have reported a session ID. Regular terminals reopen their shell in
the saved working directory.

Run all automated checks with:

```sh
make test
```

## Current boundaries

Browser disconnects do not terminate PTY processes. The in-memory terminal
history buffer is configurable in Settings from 1–4095 MiB or Unlimited, but
scrollback is not persisted across server restarts. Multi-user accounts and
file management are not implemented.
