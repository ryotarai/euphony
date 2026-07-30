# Automation API and CLI

Euphony exposes one v1 automation contract over TCP HTTP/WebSocket and a local
Unix socket. Both transports control the same live PTYs, agent metadata, and
server-wide browser selection.

## Transport selection

The server always starts its configured TCP listener and one Unix listener.
The Unix path is selected in this order:

1. `EUPHONY_SOCKET`;
2. `$XDG_RUNTIME_DIR/euphony/euphony.sock`;
3. `~/.local/euphony/euphony.sock`.

The Unix socket is created with mode `0600`; a parent directory created by
Euphony uses mode `0700`. Unix requests do not require a bearer token. TCP requests require
`Authorization: Bearer <EUPHONY_TOKEN>` except for status, schema, and a
single-use-ticket terminal WebSocket.

The CLI uses an active Unix socket by default. Select a transport explicitly
with:

```sh
euphony --socket /path/to/euphony.sock status
euphony --url https://euphony.example.test --token "$EUPHONY_TOKEN" status
```

`EUPHONY_SOCKET`, `EUPHONY_URL`, and `EUPHONY_TOKEN` provide the equivalent
environment configuration. Explicit `--socket` or `--url` wins first, then
`EUPHONY_URL`, then an active configured/default Unix socket, and finally the
default TCP URL. An explicit URL selects TCP even when a socket exists.

## JSON contract

Finite API and CLI operations return:

```json
{"ok":true,"result":{}}
```

Errors return:

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

CLI successes go to stdout with status 0. API or connection errors go to
stderr with status 1. Invalid CLI syntax goes to stderr with status 2.
`api schema` returns the raw OpenAPI document. Long-lived subscriptions use
one JSON record per line.

Terminal bytes are represented as unpadded base64 in `dataBase64`. A terminal
read also includes a lossy `text` convenience value with ANSI control
sequences removed.

## Terminal commands

```text
euphony terminal list
euphony terminal get ID
euphony terminal create [--name NAME] [--cwd PATH]
                        [--selection none|add|replace]
euphony terminal delete ID
euphony terminal read [--max-bytes N] ID
euphony terminal send-text ID TEXT
euphony terminal send-keys ID KEY...
euphony terminal run ID COMMAND
euphony terminal wait-output [--match TEXT | --regex RE2]
                             [--timeout MS] [--max-bytes N] ID
euphony terminal observe ID
euphony terminal attach ID
```

Use `-` as the text argument to read `send-text` input from stdin. Logical key
names include `enter`, `tab`, `escape`, `backspace`, arrows, navigation keys,
and modifier combinations such as `ctrl+c`.

`terminal run` is safer than raw input for shell automation. It succeeds only
when the shell owns the PTY foreground and returns `terminal_busy` when an
editor, agent, or another foreground process is active.

`terminal observe` emits WebSocket frames as NDJSON and cannot write to the
PTY. `terminal attach` is the interactive exception to JSON output: it writes
decoded terminal bytes directly to stdout and forwards stdin.

## Agent commands

```text
euphony agent list
euphony agent get TERMINAL_ID
euphony agent start --kind codex|claude [--arg ARG] [--timeout MS] TERMINAL_ID
euphony agent read [--source transcript|terminal] [--max-bytes N] TERMINAL_ID
euphony agent prompt [--wait] [--until STATE] [--timeout MS]
                     TERMINAL_ID PROMPT
euphony agent send-keys TERMINAL_ID KEY...
euphony agent wait [--until STATE] [--timeout MS] TERMINAL_ID
```

Agent targets are terminal IDs. Codex and Claude must have Euphony lifecycle
hooks installed with `euphony setup`. A start operation waits for the matching
start hook. A prompt sent with `--wait` observes a `running` transition before
accepting `waiting` or `blocked`, preventing a stale pre-prompt state from
completing the wait. Prompt and key input also verify that the reported Codex
or Claude process still owns the PTY foreground, so stale hook metadata cannot
send input into a returned shell or another foreground program.

Use `-` as the prompt argument to read up to 1 MiB from stdin.

## Shared selection commands

The selection is stored once by the server and shared by every browser and
CLI client. `terminalIds` is derived from manual terminals, pins, status
filters, and status-by-CWD filters.

```text
euphony selection get
euphony selection replace [--file PATH]
euphony selection add ID...
euphony selection remove ID...
euphony selection focus ID
euphony selection pin ID...
euphony selection unpin ID...
euphony selection filter status set|add|remove STATUS...
euphony selection filter cwd set|add|remove STATUS=CWD...
```

`selection replace` reads a complete request from stdin by default:

```json
{
  "manualTerminalIds": ["terminal-1"],
  "pinnedTerminalIds": ["terminal-2"],
  "focusedTerminalId": "terminal-1",
  "filters": {
    "statuses": ["blocked"],
    "cwds": [{"status": "running", "cwd": "/repo"}]
  },
  "pinnedFilters": {
    "statuses": ["blocked"],
    "cwds": []
  },
  "expectedRevision": 42
}
```

Include `expectedRevision` for optimistic concurrency. A stale revision
returns `selection_conflict`.

## Events and schema

Subscribe to all events or repeat `--type` to filter them:

```sh
euphony events subscribe
euphony events subscribe \
  --type terminal.created \
  --type agent.updated \
  --type selection.changed
```

Event records contain `sequence`, `occurredAt`, `type`, and `data`. Initial
types are `terminal.created`, `terminal.updated`, `terminal.deleted`,
`agent.updated`, and `selection.changed`. Heartbeats keep idle subscriptions
observable. A subscriber that cannot keep up receives `subscriber_lagged` and
is disconnected.

Fetch the raw OpenAPI 3.1 document with:

```sh
euphony api schema
euphony api schema --output ./euphony-openapi.json
```

The HTTP endpoints are rooted at `/api/v1`; the schema is also available from
`GET /api/v1/schema`. `--output` replaces the destination atomically and
returns a normal JSON success envelope.
