# Automation API and CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Euphony's stable terminal-first automation API and JSON CLI over TCP and Unix sockets, including shared browser selection, agent control, events, and schema discovery.

**Architecture:** A new `internal/control` service composes the existing session manager, a persistent selection reducer, and a bounded event hub. Versioned handlers expose that service through one HTTP handler mounted on both TCP and Unix listeners; `internal/client` and `cmd/euphony` provide the CLI. The browser migrates its selection authority to the server and consumes the same snapshots and events.

**Tech Stack:** Go 1.24+, `net/http`, `github.com/coder/websocket`, `github.com/creack/pty`, modernc SQLite, React 19, TypeScript, Vitest, Playwright.

## Global Constraints

- Keep `/api/sessions` and the existing browser terminal WebSocket compatible during migration.
- Use `terminal` in all new public API and CLI names; `session` remains an internal package name.
- Preserve arbitrary PTY bytes with unpadded base64 across every JSON boundary.
- Require bearer authentication over TCP; allow owner-only Unix socket requests without a token.
- Print finite CLI success JSON on stdout, API errors JSON on stderr with exit 1, and syntax errors JSON on stderr with exit 2.
- Persist one server-wide selection, not one selection per browser.
- Run state-mutating end-to-end tests with one worker and an isolated database, TCP port, and Unix socket.
- Support only Codex and Claude agent lifecycle operations in v1.

---

### Task 1: Versioned response contract and embedded schema

**Files:**
- Create: `internal/server/v1_response.go`
- Create: `internal/server/v1_schema.go`
- Create: `internal/server/openapi.json`
- Create: `internal/server/v1_test.go`
- Modify: `internal/server/server.go`

**Interfaces:**
- Produces: `writeV1Result(http.ResponseWriter, int, any)`.
- Produces: `writeV1Error(http.ResponseWriter, int, string, string, any)`.
- Produces: `GET /api/v1/status` and raw `GET /api/v1/schema`.

- [ ] **Step 1: Write failing envelope, authentication, status, and schema tests**

```go
func TestV1StatusUsesStableEnvelope(t *testing.T) {
    response := performRequest(t, newTestServer(t), http.MethodGet, "/api/v1/status", "")
    if response.Code != http.StatusOK ||
        response.Body.String() != "{\"ok\":true,\"result\":{\"status\":\"ok\",\"apiVersion\":\"v1\"}}\n" {
        t.Fatalf("status response = %d %s", response.Code, response.Body.String())
    }
}

func TestV1SchemaIsRawOpenAPI(t *testing.T) {
    response := performRequest(t, newTestServer(t), http.MethodGet, "/api/v1/schema", "")
    var document struct {
        OpenAPI string `json:"openapi"`
    }
    decodeResponse(t, response, &document)
    if document.OpenAPI != "3.1.0" {
        t.Fatalf("openapi = %q", document.OpenAPI)
    }
}
```

- [ ] **Step 2: Run the focused tests and confirm 404 failures**

Run: `go test ./internal/server -run 'TestV1(Status|Schema)'`

Expected: FAIL because `/api/v1/status` and `/api/v1/schema` are not registered.

- [ ] **Step 3: Implement the v1 envelope helpers and embed a complete OpenAPI skeleton**

```go
type v1Envelope struct {
    OK     bool       `json:"ok"`
    Result any        `json:"result,omitempty"`
    Error  *v1APIError `json:"error,omitempty"`
}

//go:embed openapi.json
var openAPIDocument []byte

func writeV1Result(w http.ResponseWriter, status int, result any) {
    writeJSON(w, status, v1Envelope{OK: true, Result: result})
}
```

Register the two public paths before the protected `/api/v1/` mux. Include
component schemas for the success envelope, error envelope, terminal metadata,
selection snapshot, event record, and base64 terminal frame.

- [ ] **Step 4: Run focused and package tests**

Run: `go test ./internal/server`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/server
git commit -m "feat: add versioned API contract"
```

---

### Task 2: Persistent selection reducer

**Files:**
- Create: `internal/selection/types.go`
- Create: `internal/selection/reducer.go`
- Create: `internal/selection/reducer_test.go`
- Modify: `internal/session/sqlite_store.go`
- Modify: `internal/session/sqlite_store_test.go`

**Interfaces:**
- Produces: `selection.State`, `selection.Snapshot`, `selection.Action`, and `selection.Apply`.
- Produces: `SQLiteStore.LoadSelection(context.Context)` and `SaveSelection(context.Context, selection.State)`.
- Produces: `Manager.LoadSelection(context.Context)` and `SaveSelection(context.Context, selection.State)` wrappers for persistent and in-memory managers.
- Consumes: terminal projections with `ID`, `CWD`, `AgentStatus`, and `NeedsAttention`.

- [ ] **Step 1: Write table-driven failing reducer tests**

```go
func TestApplyPinSelectsTerminalAndUnpinPreservesManualSelection(t *testing.T) {
    terminals := []Terminal{{ID: "t1", CWD: "/repo", Statuses: []string{"running"}}}
    state, err := Apply(State{ManualTerminalIDs: []string{"t1"}}, Action{
        Type: ActionPin, TerminalIDs: []string{"t1"},
    }, terminals)
    if err != nil || !reflect.DeepEqual(state.PinnedTerminalIDs, []string{"t1"}) {
        t.Fatalf("pin = %#v, %v", state, err)
    }
    state, err = Apply(state, Action{Type: ActionUnpin, TerminalIDs: []string{"t1"}}, terminals)
    snapshot := Resolve(state, terminals)
    if err != nil || !reflect.DeepEqual(snapshot.TerminalIDs, []string{"t1"}) {
        t.Fatalf("unpin = %#v, %v", snapshot, err)
    }
}
```

Cover replace/add/remove/focus/pin/unpin, invalid IDs, revision conflict,
status filter decomposition, cwd filter removal, attention overlay matching,
focus repair, terminal deletion, and agent promotion.

- [ ] **Step 2: Run reducer tests and confirm undefined-type failures**

Run: `go test ./internal/selection`

Expected: FAIL because the package does not exist.

- [ ] **Step 3: Implement immutable normalization and action reduction**

```go
type State struct {
    ManualTerminalIDs []string    `json:"manualTerminalIds"`
    PinnedTerminalIDs []string    `json:"pinnedTerminalIds"`
    FocusedTerminalID string      `json:"focusedTerminalId,omitempty"`
    StatusFilters     []string    `json:"statusFilters"`
    CWDFilters        []CWDFilter `json:"cwdFilters"`
    Revision          uint64      `json:"revision"`
}

type Snapshot struct {
    TerminalIDs       []string    `json:"terminalIds"`
    ManualTerminalIDs []string    `json:"manualTerminalIds"`
    PinnedTerminalIDs []string    `json:"pinnedTerminalIds"`
    FocusedTerminalID string      `json:"focusedTerminalId,omitempty"`
    Filters           Filters     `json:"filters"`
    Revision          uint64      `json:"revision"`
}
```

All returned slices must be copies, duplicate IDs must collapse while
preserving terminal creation order, and every successful mutation increments
the revision exactly once.

- [ ] **Step 4: Add the singleton SQLite table and round-trip tests**

Use one row with JSON columns and an integer revision:

```sql
CREATE TABLE IF NOT EXISTS selection (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    manual_terminal_ids TEXT NOT NULL,
    pinned_terminal_ids TEXT NOT NULL,
    focused_terminal_id TEXT NOT NULL,
    status_filters TEXT NOT NULL,
    cwd_filters TEXT NOT NULL,
    revision INTEGER NOT NULL
)
```

Set `PRAGMA user_version = 7`. Verify an old database migrates without changing
terminal or settings rows.

- [ ] **Step 5: Run focused persistence tests**

Run: `go test ./internal/selection ./internal/session -run 'Selection|Migration'`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/selection internal/session
git commit -m "feat: persist shared terminal selection"
```

---

### Task 3: Control service and event hub

**Files:**
- Create: `internal/control/service.go`
- Create: `internal/control/events.go`
- Create: `internal/control/events_test.go`
- Create: `internal/control/selection_test.go`
- Modify: `internal/session/manager.go`
- Modify: `internal/server/server.go`

**Interfaces:**
- Produces: `control.New(*session.Manager) (*Service, error)`.
- Produces: `Service.Selection() selection.Snapshot`.
- Produces: `Service.ApplySelection(context.Context, selection.Action) (selection.Snapshot, error)`.
- Produces: `Service.SubscribeEvents([]string) (<-chan Event, func())`.
- Produces: `session.Manager.SetChangeHandler(func(session.Change))`.

- [ ] **Step 1: Write failing event ordering and selection reconciliation tests**

```go
func TestServicePublishesSelectionAfterAgentStatusChanges(t *testing.T) {
    manager := session.NewManager("/bin/sh")
    service, err := New(manager)
    if err != nil { t.Fatal(err) }
    events, unsubscribe := service.SubscribeEvents([]string{"selection.changed"})
    defer unsubscribe()
    // Create two terminal projections and activate the running filter.
    // Update one terminal from waiting to running through Manager.UpdateAgent.
    event := receiveEvent(t, events)
    if event.Type != "selection.changed" {
        t.Fatalf("event = %#v", event)
    }
}
```

Also cover monotonic sequences, type filtering, queue overflow termination,
terminal deletion, cwd changes, attention overlay, and focused agent
promotion.

- [ ] **Step 2: Run control tests and confirm missing-package failures**

Run: `go test ./internal/control`

Expected: FAIL because the package does not exist.

- [ ] **Step 3: Add manager change notifications outside manager locks**

```go
type Change struct {
    Kind   ChangeKind
    Before *Metadata
    After  *Metadata
}

func (m *Manager) SetChangeHandler(handler func(Change)) {
    m.mu.Lock()
    m.changeHandler = handler
    m.mu.Unlock()
}
```

Publish create, metadata update, cwd update, attention acknowledgement, delete,
process exit, restored-terminal registration, and Codex title updates. Copy
metadata values and invoke the handler only after releasing `m.mu`.

- [ ] **Step 4: Implement the bounded event hub and selection service**

Use a queue of 128 events per subscriber. Publishing must never block. Close a
lagging subscriber after enqueueing one `subscriber_lagged` record. On every
manager change, reconcile persisted selection first, then publish terminal or
agent events followed by `selection.changed` when the resolved snapshot
changed.

- [ ] **Step 5: Run control and manager tests**

Run: `go test ./internal/control ./internal/session`

Expected: PASS with race-safe subscriptions.

- [ ] **Step 6: Commit**

```bash
git add internal/control internal/session internal/server/server.go
git commit -m "feat: coordinate selection and state events"
```

---

### Task 4: Terminal control primitives

**Files:**
- Create: `internal/control/terminal.go`
- Create: `internal/control/terminal_test.go`
- Create: `internal/session/foreground_darwin.go`
- Create: `internal/session/foreground_linux.go`
- Create: `internal/session/foreground_other.go`
- Modify: `internal/session/session.go`
- Modify: `internal/session/manager.go`

**Interfaces:**
- Produces: `Session.HistorySnapshot(maxBytes int) (data []byte, truncated bool)`.
- Produces: `Session.ForegroundIsShell() (bool, error)`.
- Produces: `Service.ReadTerminal`, `SendTerminalInput`, `RunTerminal`, and `WaitOutput`.
- Produces: `control.EncodeKeys([]string) ([]byte, error)`.

- [ ] **Step 1: Write failing history, key, run, and wait tests**

```go
func TestReadTerminalPreservesArbitraryBytes(t *testing.T) {
    terminal := newControlledTerminal(t)
    terminal.publish([]byte{0xff, 0x00, 0x1b, '[', '3', '1', 'm'})
    result, err := terminal.service.ReadTerminal("t1", 1024)
    if err != nil || result.DataBase64 != "_wAbWzMxbQ" {
        t.Fatalf("read = %#v, %v", result, err)
    }
}
```

Cover history tail truncation, split UTF-8, ANSI stripping, key validation,
foreground-shell rejection, immediate history matching, future output
matching, regex validation, timeout, and cancellation.

- [ ] **Step 2: Run focused tests and confirm missing-method failures**

Run: `go test ./internal/control ./internal/session -run 'Terminal|History|Foreground|WaitOutput'`

Expected: FAIL because control primitives are undefined.

- [ ] **Step 3: Implement lossless snapshots and foreground checks**

Copy retained chunks while holding `outputMu`, then release the lock before
joining and tail-limiting bytes. On Darwin and Linux compare the PTY foreground
process group with the shell command process group. Return
`ErrForegroundUnsupported` on other systems.

- [ ] **Step 4: Implement input, key encoding, ANSI text, run, and waits**

Accept exactly one of text, `dataBase64`, or keys. Map `enter`, `esc`, arrows,
tab, backspace, delete, home, end, page keys, and `ctrl+a` through `ctrl+z`.
Reject unknown values before writing any byte. Use a bounded 1 MiB rolling
buffer for literal and RE2 line matches.

- [ ] **Step 5: Run tests**

Run: `go test ./internal/control ./internal/session`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/control internal/session
git commit -m "feat: add terminal automation primitives"
```

---

### Task 5: Versioned terminal and event handlers

**Files:**
- Create: `internal/server/v1_terminal.go`
- Create: `internal/server/v1_terminal_test.go`
- Create: `internal/server/v1_events.go`
- Create: `internal/server/v1_events_test.go`
- Modify: `internal/server/server.go`
- Modify: `internal/server/tickets.go`
- Modify: `internal/server/terminal.go`
- Modify: `internal/server/openapi.json`

**Interfaces:**
- Consumes: Task 3 control service and Task 4 terminal operations.
- Produces: every terminal and event endpoint listed in the design.

- [ ] **Step 1: Write failing handler contract tests**

```go
func TestV1TerminalInputDecodesBase64Losslessly(t *testing.T) {
    response := performV1Request(t, srv, http.MethodPost,
        "/api/v1/terminals/"+id+"/input", `{"dataBase64":"_wA"}`)
    requireV1OK(t, response, http.StatusOK)
    if got := <-ptyWrites; !bytes.Equal(got, []byte{0xff, 0x00}) {
        t.Fatalf("write = %x", got)
    }
}
```

Cover every method/status/code, body limits, unknown fields, creation selection
mode, output reads, wait cancellation, observe tickets, NDJSON events,
heartbeats, and type filters.

- [ ] **Step 2: Run focused tests and confirm route failures**

Run: `go test ./internal/server -run 'TestV1(Terminal|Events)'`

Expected: FAIL with v1 404 responses.

- [ ] **Step 3: Implement strict handlers and v1 ticket modes**

Factor strict JSON decoding into a helper capped at 1 MiB. Extend tickets with
`readOnly bool`. Route v1 stream tickets to the existing WebSocket pump and
reject input/resize/cwd messages for read-only connections.

- [ ] **Step 4: Implement NDJSON state events**

Flush each event record immediately. Write a heartbeat record every 15 seconds.
Stop subscription and timers on request cancellation. Return
`streaming_unsupported` when `http.Flusher` is absent.

- [ ] **Step 5: Complete terminal paths and schemas in OpenAPI**

Add exact request and response components, stable error codes, event types, and
the `x-euphony-websocket` frame union. Validate `openapi.json` parses in tests.

- [ ] **Step 6: Run server tests**

Run: `go test ./internal/server`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add internal/server
git commit -m "feat: expose terminal automation API"
```

---

### Task 6: Agent control and handlers

**Files:**
- Create: `internal/control/agent.go`
- Create: `internal/control/agent_test.go`
- Create: `internal/server/v1_agent.go`
- Create: `internal/server/v1_agent_test.go`
- Modify: `internal/server/agent_log.go`
- Modify: `internal/server/hooks.go`
- Modify: `internal/server/openapi.json`

**Interfaces:**
- Produces: `Service.ListAgents`, `GetAgent`, `StartAgent`, `ReadAgent`, `PromptAgent`, and `WaitAgent`.
- Produces: all `/api/v1/agents` routes.

- [ ] **Step 1: Write failing agent lifecycle tests with fake hook updates**

```go
func TestStartAgentWaitsForExpectedSessionStart(t *testing.T) {
    service, writes := newAgentService(t)
    result := make(chan error, 1)
    go func() {
        _, err := service.StartAgent(context.Background(), "t1", "codex", nil, time.Second)
        result <- err
    }()
    requireShellCommand(t, writes, "codex")
    service.UpdateAgent("t1", session.AgentUpdate{Agent: "codex", Status: "waiting"})
    if err := <-result; err != nil { t.Fatal(err) }
}
```

Cover unsupported kinds, busy terminals, safe argument quoting, wrong-agent
hooks, startup timeout, prompt bracketed paste, required running transition,
explicit until states, agent disappearance, structured transcript reads, and
logical key forwarding.

- [ ] **Step 2: Run focused tests and confirm failures**

Run: `go test ./internal/control ./internal/server -run 'Test(V1)?Agent'`

Expected: FAIL because agent control is undefined.

- [ ] **Step 3: Implement hook-driven agent waiters**

Maintain waiter registrations keyed by terminal ID in the control service.
Manager change events wake waiters. Validate states against
`running|waiting|blocked`, always honor context cancellation, and remove waiter
channels on every return path.

- [ ] **Step 4: Implement safe starts and prompts**

Allow only `codex` and `claude`. Quote each argument with single-quote escaping,
reject NUL bytes, send `\r`, and wait up to 30 seconds by default for the
matching waiting hook. Prompt bytes are `ESC[200~ + text + ESC[201~ + CR`.

- [ ] **Step 5: Add strict v1 handlers and schema paths**

Return terminal metadata plus current agent fields in the result. Reuse the
bounded transcript resolver and the terminal base64 read result.

- [ ] **Step 6: Run control and server tests**

Run: `go test ./internal/control ./internal/server`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add internal/control internal/server
git commit -m "feat: expose coding agent automation"
```

---

### Task 7: Unix listener and shared API client

**Files:**
- Create: `internal/localapi/socket.go`
- Create: `internal/localapi/socket_test.go`
- Create: `internal/client/client.go`
- Create: `internal/client/client_test.go`
- Modify: `cmd/euphony/main.go`
- Modify: `cmd/euphony/main_test.go`

**Interfaces:**
- Produces: `localapi.Listen(path string) (net.Listener, cleanup func() error, err error)`.
- Produces: `client.New(client.Config) (*Client, error)` with TCP or Unix transport.
- Produces: typed finite methods and streaming `Events`, `Observe`, and `Attach`.

- [ ] **Step 1: Write failing socket lifecycle and parity tests**

```go
func TestListenCreatesPrivateSocketAndRejectsLiveServer(t *testing.T) {
    path := filepath.Join(t.TempDir(), "euphony.sock")
    listener, cleanup, err := Listen(path)
    if err != nil { t.Fatal(err) }
    defer cleanup()
    info, err := os.Stat(path)
    if err != nil || info.Mode().Perm() != 0o600 {
        t.Fatalf("socket mode = %v, %v", info.Mode().Perm(), err)
    }
    if _, _, err := Listen(path); !errors.Is(err, ErrServerRunning) {
        t.Fatalf("second listen error = %v", err)
    }
}
```

Also cover stale socket cleanup, default path resolution, graceful removal,
Unix requests without token, TCP token requirement, identical status results,
API error decoding, context cancellation, and WebSocket dialing over Unix.

- [ ] **Step 2: Run focused tests and confirm missing-package failures**

Run: `go test ./internal/localapi ./internal/client`

Expected: FAIL because the packages do not exist.

- [ ] **Step 3: Implement safe socket creation and transport authentication**

Create parents with `0700`, probe existing sockets with a short deadline,
remove only sockets that return connection-refused/not-found, listen with
`net.ListenUnix`, and chmod to `0600`. Mark Unix requests in request context so
v1 auth accepts them without weakening TCP auth.

- [ ] **Step 4: Implement the shared client**

Use `http.Transport.DialContext` for Unix and normal URLs for TCP. Keep one
`doJSON` path for envelopes. Use `websocket.DialOptions.HTTPClient` for stream
tickets and preserve frame base64 fields unchanged.

- [ ] **Step 5: Start and stop the Unix HTTP server with the TCP server**

Resolve the path in `runServer`, serve the same handler, propagate non-shutdown
listener errors, and call cleanup after both servers stop. Include the socket
path in the startup log.

- [ ] **Step 6: Run package and command tests**

Run: `go test ./internal/localapi ./internal/client ./cmd/euphony`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add internal/localapi internal/client cmd/euphony
git commit -m "feat: serve API over Unix sockets"
```

---

### Task 8: JSON CLI command tree

**Files:**
- Create: `cmd/euphony/cli.go`
- Create: `cmd/euphony/cli_test.go`
- Modify: `cmd/euphony/main.go`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 7 `client.Client`.
- Produces: the complete CLI tree from the design with stable stdout/stderr and exit codes.

- [ ] **Step 1: Write failing table-driven parser and output tests**

```go
func TestCLIListTerminalsPrintsSuccessJSON(t *testing.T) {
    stdout, stderr := new(bytes.Buffer), new(bytes.Buffer)
    code := runCLI(context.Background(), []string{"terminal", "list"},
        fakeClient{terminals: []Terminal{{ID: "t1"}}}, stdout, stderr)
    if code != 0 || stderr.Len() != 0 ||
        stdout.String() != "{\"ok\":true,\"result\":{\"terminals\":[{\"id\":\"t1\"}]}}\n" {
        t.Fatalf("code=%d stdout=%s stderr=%s", code, stdout, stderr)
    }
}
```

Cover every subcommand, environment/flag precedence, repeated `--until`, cwd
filters containing spaces, `--output` atomic schema writes, malformed base64,
stream NDJSON pass-through, server error exit 1, and usage error exit 2.

- [ ] **Step 2: Run CLI tests and confirm unknown-command failures**

Run: `go test ./cmd/euphony -run CLI`

Expected: FAIL because automation commands are not parsed.

- [ ] **Step 3: Refactor `run` to return typed CLI exit errors**

Keep existing `setup`, `hook`, and no-argument server behavior. Automation
commands call `runCLI`; `main` prints an already-encoded error once and exits
with its declared status instead of `log.Fatal` adding a prefix.

- [ ] **Step 4: Implement status, schema, events, terminal, agent, and selection commands**

Use one `flag.FlagSet` per leaf command with `ContinueOnError` and discarded
default output. Validate mutually exclusive options before client calls.
Streaming commands encode one JSON record per line and flush stdout.

- [ ] **Step 5: Document connection resolution and examples**

Add Unix-default, remote TCP, JSON/exit behavior, selection examples, agent
prompt/wait recipes, and raw-byte examples to `README.md`.

- [ ] **Step 6: Run CLI and full Go tests**

Run: `go test ./cmd/euphony ./internal/client ./internal/server`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add cmd/euphony README.md
git commit -m "feat: add automation CLI"
```

---

### Task 9: Browser shared-selection synchronization

**Files:**
- Create: `web/src/workspace-selection.ts`
- Create: `web/src/workspace-selection.test.ts`
- Modify: `web/src/types.ts`
- Modify: `web/src/api.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.test.tsx`

**Interfaces:**
- Consumes: v1 terminal, selection, and event endpoints.
- Produces: browser rendering driven by `SelectionSnapshot`, with local UI actions persisted atomically.

- [ ] **Step 1: Write failing reducer and App synchronization tests**

```tsx
it("applies a remote selection event to panes, pins, focus, and filters", async () => {
  const api = createControllableAPI({
    selection: selectionSnapshot(["t1"], [], "t1"),
  });
  render(<App apiFactory={() => api.client} />);
  api.emit({
    type: "selection.changed",
    data: selectionSnapshot(["t1", "t2"], ["t2"], "t2", ["running"]),
  });
  expect(await screen.findByLabelText("Terminal two pane")).toBeVisible();
  expect(screen.getByLabelText("Include Terminal two in split")).toHaveAttribute("data-pinned");
});
```

Cover initial snapshots, add/remove/focus/pin actions, status and cwd filters,
revision conflict refresh, event reconnect snapshot refresh, deleted
terminals, agent promotion, URL mirror behavior, and no write-back loop after a
remote event.

- [ ] **Step 2: Run focused Web tests and confirm failures**

Run: `cd web && npm test -- --run src/workspace-selection.test.ts src/App.test.tsx`

Expected: FAIL because the v1 selection client and event stream do not exist.

- [ ] **Step 3: Add TypeScript v1 types and API methods**

Define `SelectionSnapshot`, `SelectionAction`, `APIEvent`, and v1 envelopes.
Implement `getSelection`, `applySelection`, `replaceSelection`, and a
fetch-stream NDJSON `subscribeEvents(signal, onEvent)` method with bearer
headers.

- [ ] **Step 4: Extract selection projection and migrate App authority**

Replace `filterSelectedIDsRef` and URL restoration as state authorities with
the server snapshot. UI handlers send atomic actions; successful responses
replace the complete local snapshot. Remote events replace snapshots without
issuing another mutation. Keep `writeWorkspaceToURL(..., "replace")` only as a
shareable mirror.

- [ ] **Step 5: Reconnect state events with snapshot recovery**

On event EOF or parse failure, wait with bounded backoff, refetch terminals and
selection, then reconnect. Abort all fetches and timers on token change or
unmount. Keep the existing 1.5-second terminal polling only as a temporary
fallback when event streaming is unavailable.

- [ ] **Step 6: Run Web tests and typecheck**

Run: `cd web && npm test -- --run && npm run typecheck`

Expected: 107 existing tests plus new tests PASS.

- [ ] **Step 7: Commit**

```bash
git add web/src
git commit -m "feat: synchronize browser workspace selection"
```

---

### Task 10: End-to-end automation verification

**Files:**
- Create: `web/e2e/automation-api-cli.spec.ts`
- Modify: `web/playwright.config.ts`
- Modify: `scripts/dev_test.sh`
- Modify: `Makefile`
- Modify: `README.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: built `bin/euphony`, isolated `EUPHONY_DB`, `EUPHONY_ADDR`, and `EUPHONY_SOCKET`.
- Produces: repeatable one-worker CLI-to-browser and terminal automation evidence.

- [ ] **Step 1: Write the failing Playwright scenario**

```ts
test("CLI selection changes update the open browser", async ({ page }) => {
  const created = await euphonyJSON(["terminal", "create", "--cwd", projectDir]);
  const id = created.result.terminal.id;
  await euphonyJSON(["selection", "replace", id]);
  await expect(page.locator(`[data-terminal-id="${id}"]`)).toBeVisible();
  await euphonyJSON(["selection", "pin", id]);
  await expect(page.getByLabel(`Include ${created.result.terminal.name} in split`))
    .toHaveAttribute("data-pinned", "true");
});
```

Add a second scenario that runs `printf 'AUTOMATION_OK\n'`, waits for the
literal output, reads `dataBase64`, and verifies decoded bytes contain the
marker.

- [ ] **Step 2: Run the new scenario and confirm failure**

Run: `cd web && npx playwright test e2e/automation-api-cli.spec.ts --workers=1`

Expected: FAIL until the production server fixture exposes the socket and CLI.

- [ ] **Step 3: Add an isolated production-server fixture**

Allocate a temporary database and socket, an unused TCP port, and a temporary
home. Build once, start the server with explicit token, wait on `/api/health`,
and terminate it in fixture teardown. Never reuse the developer's persisted
database.

- [ ] **Step 4: Add CLI integration and e2e targets**

Add `make test-cli` and ensure `make test` runs the deterministic CLI
integration tests. Keep Playwright at one worker for state-mutating scenarios.

- [ ] **Step 5: Add the reusable workflow lesson to AGENTS.md**

Add this concise rule:

> Exercise public automation features through the built CLI against both the
> Unix socket and TCP API; do not treat handler-only tests as transport proof.

- [ ] **Step 6: Run complete verification**

Run: `make test`

Run: `cd web && npx playwright test e2e/automation-api-cli.spec.ts --workers=1`

Expected: all Go, Vitest, typecheck, CLI integration, and Playwright checks PASS.

- [ ] **Step 7: Commit**

```bash
git add web/e2e web/playwright.config.ts scripts Makefile README.md AGENTS.md
git commit -m "test: verify automation API and CLI end to end"
```

---

### Task 11: Completion audit and branch integration

**Files:**
- Modify only files required by audit findings.

**Interfaces:**
- Consumes: the design spec and all prior task commits.
- Produces: verified, merged implementation on the base branch.

- [ ] **Step 1: Audit every design requirement against source and tests**

Create a temporary checklist from the design sections: transports/auth,
envelopes, terminal operations, agent operations, selection behavior, events,
schema, CLI, browser sync, persistence, compatibility, and verification. For
each item record the exact source and test proving it; implement and test any
missing item before continuing.

- [ ] **Step 2: Run formatting and static checks**

Run: `gofmt -w cmd internal`

Run: `go test ./...`

Run: `cd web && npm test -- --run && npm run typecheck`

Expected: all PASS with no formatting diff generated after the final run.

- [ ] **Step 3: Run isolated end-to-end checks**

Run: `cd web && npx playwright test --workers=1`

Expected: all Playwright scenarios PASS using isolated server state.

- [ ] **Step 4: Inspect the final diff and repository state**

Run: `git diff --check HEAD~10..HEAD`

Run: `git status --short`

Run: `git log --oneline --decorate -12`

Expected: no whitespace errors, a clean worktree, and focused task commits.

- [ ] **Step 5: Merge into the base branch**

From the base checkout, fetch its current branch state, merge
`feature/herdr-api-cli` with a non-fast-forward merge, resolve only overlapping
task changes, and rerun `make test`. Do not overwrite unrelated base-branch
changes.

- [ ] **Step 6: Record final verification evidence**

Report the merged commit, API/CLI command groups, Unix and TCP evidence,
selection/browser synchronization evidence, schema location, and exact passing
test commands.
