# Automation API and CLI Design

## Goal

Expose Euphony as a deterministic automation layer for terminals and coding
agents. A script or another coding agent must be able to inspect and control
the same terminals and workspace selection that the browser displays.

The first stable version provides:

- one versioned API over TCP HTTP/WebSocket and a local Unix socket;
- JSON-only CLI responses for deterministic scripting;
- terminal lifecycle, input, output, streaming, and output waits;
- Codex and Claude lifecycle, prompt, transcript, and state waits;
- one persistent server-wide selection, including focus, pins, status filters,
  and status-by-cwd filters;
- event subscriptions for terminal, agent, and selection changes; and
- a bundled machine-readable API schema.

The design uses Euphony's terminal-first model. It does not add Herdr's
workspace, tab, or pane topology.

## Non-goals

- Named selections or multiple server-side workspaces.
- Agent aliases independent from terminal IDs.
- Automatic screen-based agent detection.
- Support for agents other than Codex and Claude in v1.
- A plugin or integration marketplace.
- A server-side terminal emulator that reproduces a rendered visible screen.
- Multi-user authorization, roles, or shared remote accounts.

## Approaches

Three transport designs were considered:

1. Serve the same HTTP API through the existing TCP listener and a Unix socket.
   The CLI selects a transport but uses one contract and client.
2. Make a new JSON-RPC Unix socket protocol canonical and translate the browser
   HTTP API through a gateway.
3. Let the CLI call session-manager internals and the SQLite database directly.

Use approach 1. It avoids two public protocols, keeps remote operation, and
allows the existing browser to migrate incrementally. Direct process or
database access cannot safely coordinate with the running PTYs.

## Architecture

Add a transport-neutral control layer between HTTP handlers and the existing
session manager:

- `internal/control` owns public terminal and agent operations, waits, event
  publication, and the selection service.
- `internal/session` continues to own PTYs, byte history, metadata, and
  persistence.
- `internal/server` maps `/api/v1` requests to control operations and serves
  streaming connections.
- `internal/client` implements the shared TCP and Unix-socket API client used
  by the CLI.
- `cmd/euphony` parses server and automation subcommands and prints the common
  response envelopes.

The TCP and Unix listeners serve the same `http.Handler`. The existing
unversioned browser endpoints remain compatibility aliases until the browser
migration is complete.

The public resource name is `terminal`. The existing Go package and database
may continue using `session` internally.

## Transports and Authentication

The server listens on the configured TCP address and a Unix socket
simultaneously.

The socket path resolves in this order:

1. `EUPHONY_SOCKET`;
2. `$XDG_RUNTIME_DIR/euphony/euphony.sock`; or
3. `~/.local/euphony/euphony.sock`.

The parent directory is private and the socket is mode `0600`. Startup probes
an existing socket. It refuses to replace a live server socket and removes
only a confirmed stale socket. Graceful shutdown removes the socket.

TCP requests require the existing bearer token. Unix-socket requests rely on
filesystem ownership and may omit the token. The endpoints, payloads, and
responses are otherwise identical.

The CLI uses the Unix socket by default. `--socket` or `EUPHONY_SOCKET`
overrides its path. `--url` or `EUPHONY_URL` selects TCP, in which case
`--token` or `EUPHONY_TOKEN` is required.

## Response and Error Contract

Every finite successful v1 request except the raw schema document uses:

```json
{
  "ok": true,
  "result": {}
}
```

Every v1 error uses:

```json
{
  "ok": false,
  "error": {
    "code": "terminal_not_found",
    "message": "The terminal does not exist.",
    "details": {}
  }
}
```

Stable codes distinguish validation, authentication, missing resources,
selection conflicts, busy terminals, unsupported operations, timeouts, and
internal failures. Unknown fields and trailing JSON are rejected. Request
bodies and terminal read windows have explicit size limits.

`GET /api/v1/schema` is the one envelope exception: it returns the raw OpenAPI
JSON document with the OpenAPI media type so standard tooling can consume it.

Normal CLI success is JSON on stdout with exit status 0. Server or API errors
are JSON on stderr with exit status 1. CLI syntax errors are JSON on stderr
with exit status 2. Long-lived commands emit newline-delimited JSON records.

## Terminal API

The v1 terminal endpoints cover:

- list and get metadata;
- create with name, cwd, and an explicit selection mode;
- delete;
- read the retained byte history;
- send UTF-8 text, validated logical keys, or lossless base64 bytes;
- run a shell command when the interactive shell owns the PTY foreground;
- wait for a literal or RE2 regular-expression match; and
- open read-only or bidirectional WebSocket streams.

Raw bytes are canonical at every JSON boundary and use unpadded base64.
Terminal reads also include convenience UTF-8 text with ANSI control sequences
removed and invalid sequences replaced. The convenience field is explicitly
lossy and is never used to reconstruct terminal input.

An output wait first scans the retained snapshot, then subscribes to new
output. It maintains a bounded rolling match buffer, checks context
cancellation, and returns the matching line plus the terminal snapshot. A
timeout never terminates the terminal process.

`terminal run` is distinct from raw input. It checks that the shell is the PTY
foreground owner, writes the command as text, then writes Enter. It returns
`terminal_busy` for an editor, agent, or other foreground process.

The existing browser WebSocket remains bidirectional. The v1 observe stream is
read-only. Both send terminal frames as base64 so independent PTY chunks are
never stringified.

## Agent API

An agent is the recognized Codex or Claude process currently associated with a
terminal by Euphony's installed lifecycle hooks. Agent targets are terminal
IDs in v1.

The API covers:

- list and get recognized agents;
- start Codex or Claude in an available shell terminal;
- read the structured native transcript or terminal history;
- submit a prompt;
- send validated logical keys; and
- wait for `running`, `waiting`, or `blocked`.

`agent start` checks that the shell owns the PTY foreground, safely shell-quotes
the executable and arguments, and submits the command. It succeeds only after
the expected `SessionStart` hook associates that agent with the same terminal.
The default startup timeout is 30 seconds. A timeout returns a setup hint and
does not kill a process that may have started successfully.

`agent prompt` refuses a stale target whose agent no longer owns the terminal.
It uses bracketed paste followed by Enter. With `--wait`, a prompt from a
settled state must first produce an observed `running` transition, then settle
at `waiting` or `blocked` unless explicit `--until` states were supplied.

Transcript reads use the existing bounded transcript resolver. Terminal reads
use the same lossless byte snapshot as the terminal API.

## Shared Selection

Euphony stores one global selection in SQLite:

```json
{
  "terminalIds": ["t1", "t2"],
  "manualTerminalIds": ["t1"],
  "pinnedTerminalIds": ["t2"],
  "focusedTerminalId": "t1",
  "filters": {
    "statuses": ["blocked"],
    "cwds": [
      {
        "status": "running",
        "cwd": "/repo"
      }
    ]
  },
  "revision": 42
}
```

`terminalIds` is derived from explicit manual terminals, pinned terminals, and
all current matches for the dynamic filters. The server stores the source
state separately so status and cwd changes can add or remove terminals without
losing manual intent.

Status matching uses the same activity model as the sidebar. Unread attention
is an overlay, so a waiting agent with unread attention can match both
`attention` and `waiting` filters without replacing its lifecycle state.

Selection rules preserve the current UI behavior:

- Pinning selects a terminal.
- Unpinning keeps it selected when another source still owns it.
- Unchecking a child of a status filter decomposes the parent into the
  remaining status-by-cwd filters.
- Unchecking a child of a cwd filter removes that cwd filter.
- Focus must reference an effectively selected terminal.
- Removing a focused terminal moves focus to the first remaining terminal.
- Deleting a terminal removes it from every selection field.
- When the focused selected plain terminal becomes an identified agent
  session, pins remain, other non-pinned selections and filters clear, and the
  identified terminal remains selected and focused.

Terminal creation accepts `selectionMode: "none"`, `"add"`, or `"replace"`.
The CLI defaults to `none`. Browser New Terminal uses `replace`; browser Split
uses `add`.

Mutations are atomic and increment `revision`. A full replacement can include
`expectedRevision`; a mismatch returns `selection_conflict`. Action endpoints
such as add, remove, focus, pin, unpin, and filter mutation operate atomically
without a client-side read-modify-write.

The browser treats the server snapshot as authoritative. React state and URL
parameters are mirrors, not independent selection stores.

## Events

`GET /api/v1/events` is an authenticated streaming HTTP response using NDJSON.
It works over TCP and Unix HTTP without a second protocol. Optional repeated
`type` query parameters filter events.

Initial event types are:

- `terminal.created`;
- `terminal.updated`;
- `terminal.deleted`;
- `agent.updated`; and
- `selection.changed`.

Every record contains a monotonic process-local sequence, timestamp, type, and
a complete resource snapshot or deletion identity. Heartbeats keep idle
connections observable. Subscribers have bounded queues; a slow subscriber is
closed with a final `subscriber_lagged` record rather than blocking PTY or hook
processing.

On initial load or stream reconnection, the browser fetches terminal and
selection snapshots before consuming new events. Event sequence values detect
gaps but are not persisted across server restarts.

## API Surface

The versioned API is grouped as follows:

```text
GET    /api/v1/status
GET    /api/v1/schema
GET    /api/v1/events

GET    /api/v1/terminals
POST   /api/v1/terminals
GET    /api/v1/terminals/{id}
DELETE /api/v1/terminals/{id}
GET    /api/v1/terminals/{id}/output
POST   /api/v1/terminals/{id}/input
POST   /api/v1/terminals/{id}/run
POST   /api/v1/terminals/{id}/wait-output
POST   /api/v1/terminals/{id}/tickets
GET    /api/v1/terminals/{id}/stream

GET    /api/v1/agents
GET    /api/v1/agents/{terminalId}
POST   /api/v1/agents/{terminalId}/start
GET    /api/v1/agents/{terminalId}/output
POST   /api/v1/agents/{terminalId}/input
POST   /api/v1/agents/{terminalId}/prompt
POST   /api/v1/agents/{terminalId}/wait

GET    /api/v1/selection
PUT    /api/v1/selection
POST   /api/v1/selection/actions
```

The CLI mirrors this surface:

```text
euphony status
euphony api schema
euphony events subscribe

euphony terminal list|get|create|delete|read
euphony terminal send-text|send-keys|run|wait-output
euphony terminal attach|observe

euphony agent list|get|start|read|prompt|send-keys|wait

euphony selection get|replace|add|remove|focus|pin|unpin
euphony selection filter status set|add|remove
euphony selection filter cwd set|add|remove
```

## Schema

The binary embeds an OpenAPI 3.1 JSON document covering finite HTTP requests,
success envelopes, error envelopes, event records, and WebSocket frame
extensions. `GET /api/v1/schema` returns the raw document. `euphony api schema`
returns the same schema inside the standard JSON envelope; `--output PATH`
writes the raw schema document atomically and returns a JSON summary.

The checked-in schema is tested against representative handler and CLI
responses. It is the compatibility contract for `/api/v1`.

## Persistence and Compatibility

The existing SQLite database gains a singleton selection table through an
idempotent migration. Missing selection state derives an initial snapshot from
the first running terminal. In-memory test managers use an in-memory selection
store with identical semantics.

Existing terminal metadata and settings remain compatible. The browser's
current `/api/sessions` endpoints remain available while browser calls move to
the v1 client. Legacy terminal URLs may seed the initial global selection only
when the database has no stored selection; afterward the server snapshot wins.

## Verification

Go unit and integration tests cover:

- response envelopes and stable error codes;
- identical handlers over TCP and Unix-socket clients;
- socket permissions, stale detection, and cleanup;
- terminal read/input/run/wait behavior, including split UTF-8 and arbitrary
  byte chunks;
- agent start detection, prompt transitions, waits, cancellation, and timeout;
- every selection action, revision conflicts, filter decomposition, dynamic
  status/cwd membership, focus repair, agent promotion, deletion, and restart
  persistence;
- event ordering, filtering, heartbeats, reconnect snapshots, and lagging
  subscribers; and
- schema endpoint and CLI JSON/exit-status contracts.

React tests cover initial server selection, local mutations, remote CLI-style
selection changes, event reconnection, dynamic filters, and removal of URL as
an independent authority.

Playwright uses one worker and an isolated database, TCP port, and socket path.
It starts the production Go server, mutates selection through the CLI, and
asserts that the open browser updates focus, panes, pins, and filters. It also
creates a terminal, sends a command, waits for output, and observes the result
through the CLI.

The final verification is `make test`, the new CLI integration suite, the
isolated Playwright scenarios, and a clean worktree diff review.
