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

### Releases

Push any Git tag to build and publish four compressed release assets through
GitHub Actions:

```sh
git tag v0.1.0
git push origin v0.1.0
```

The GitHub Release contains these archives:

- `euphony-linux-amd64.tar.gz`
- `euphony-linux-arm64.tar.gz`
- `euphony-macos-amd64.tar.gz`
- `euphony-macos-arm64.tar.gz`

Each archive contains one `euphony` executable. To reproduce the release
build locally, run `make release-build`; the archives are written to
`dist/release`.

### macOS app

On macOS, Xcode Command Line Tools are also required to build the native app
shell:

```sh
make macos-app
open bin/Euphony.app
```

The app bundles the Go server and opens the existing workspace in a native
WebKit window. It starts a private loopback-only server on an automatically
selected port and stops that server when the app quits. The app uses the same
persistent database as the server by default; set `EUPHONY_DB` before
launching the app when a different database is needed.

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

For trusted, loopback-only development, authentication can be disabled
explicitly:

```sh
EUPHONY_AUTH_MODE=none \
EUPHONY_ADDR=127.0.0.1:8080 \
bin/euphony
```

Open the printed local address in a browser. In this mode every API endpoint
and terminal control operation is accessible without a credential, so never
bind the server to a non-loopback address or expose it through an untrusted
network. `EUPHONY_AUTH_MODE` accepts `token` (the default) or `none`; an
unknown value prevents startup.

Euphony does not terminate TLS. When the server is reachable outside a trusted
network, place it behind an HTTPS reverse proxy and restrict network access.

The token is stored in the browser's `sessionStorage`. Terminal WebSockets use
single-use tickets instead of placing the long-lived token in their URLs.
When the authenticated workspace has no terminals, Euphony starts and selects
one terminal automatically.

## Coding agent setup

On interactive startup, Euphony checks supported coding agents found on
`PATH`. If their integration is missing or outdated, it explains what will be
installed before asking for confirmation:

- Hooks report agent status and session metadata to Euphony.
- The skill lets coding agents ask you to annotate Markdown and HTML files in
  Euphony.
- Existing agent settings are preserved.

Press Enter or answer `y` to install. Answering `n` skips setup and permanently
suppresses the startup offer. Setup remains available manually:

```sh
euphony setup
```

The command prints the same explanation, then installs integrations for Codex
and Claude Code. It preserves existing hooks, can be run repeatedly without
adding duplicates, and enables Codex's lifecycle hook feature. It respects
`CODEX_HOME` and `CLAUDE_CONFIG_DIR`. Agents started inside an Euphony terminal
inherit the terminal identifier, hook endpoint, and authentication token used
by the installed hooks.

## Development

Start the Go API and Vite development server together:

```sh
make dev
```

The command opens <http://127.0.0.1:5173> in the default browser and, by
default, signs in with `development-token`. The token is removed from the
address bar immediately after the page consumes it. The command installs frontend
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

To run the development server without authentication:

```sh
EUPHONY_AUTH_MODE=none make dev
```

In this mode the development server opens the root URL without a token query
parameter. The same loopback-only warning as above applies.

Vite proxies `/api` requests and WebSockets to the configured API URL.

## Agent hooks

Every Euphony terminal receives these environment variables:

- `EUPHONY_TERMINAL_ID`: the terminal associated with the agent process
- `EUPHONY_HOOK_URL`: the endpoint that accepts agent activity
- `EUPHONY_TOKEN`: the bearer token for that endpoint; empty when
  `EUPHONY_AUTH_MODE=none`

Codex, Claude Code, or a wrapper script can report hook events with the
following request in token mode:

```sh
curl --fail --silent \
  -H "Authorization: Bearer $EUPHONY_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"terminalId\":\"$EUPHONY_TERMINAL_ID\",\"agent\":\"codex\",\"status\":\"running\",\"title\":\"Implement terminal groups\",\"cwd\":\"$PWD\"}" \
  "$EUPHONY_HOOK_URL"
```

In no-auth mode, omit the `Authorization` header. Agent hooks do this
automatically when `EUPHONY_AUTH_MODE=none` is used to start Euphony.

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

To resume a Codex or Claude Code session from a link, pass its agent, session ID,
and working directory as query parameters:

```text
/resume?agent=codex&session=<session-id>&cwd=<url-encoded-working-directory>
```

This also works when Euphony has no saved terminal record for the session. After
a successful resume, Euphony redirects `/resume` to the workspace root and
removes these parameters from the browser URL.

Run all automated checks with:

```sh
make test
```

## Current boundaries

Browser disconnects do not terminate PTY processes. The in-memory terminal
history buffer is configurable in Settings from 1–4095 MiB or Unlimited, but
scrollback is not persisted across server restarts. Multi-user accounts and
file management are not implemented.
