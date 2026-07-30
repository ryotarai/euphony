# Shared Terminal Size Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every browser attached to one terminal use the smallest connected browser capacity and center that shared grid in larger viewports.

**Architecture:** A server-owned coordinator records one capacity claim per interactive WebSocket and submits the component-wise minimum to a PTY event actor that orders output and resize boundaries. Hidden claims are excluded from the minimum while their sockets continue receiving accepted sizes. The browser receives a rendering baseline before history, measures capacity without fitting xterm, applies only server sizes, and centers the native-scale xterm root in unmarked letterbox space.

**Tech Stack:** Go 1.25, `coder/websocket`, React 19, TypeScript, xterm.js 6, Vitest, Playwright

## Global Constraints

- Valid terminal dimensions remain 1 through 1000 columns and rows.
- Read-only automation streams and connections without a size claim do not affect negotiation.
- The last PTY size remains unchanged after the final browser disconnects.
- Existing terminal palette, typography, input, history, and reconnect behavior remain unchanged.
- End-to-end tests use one worker and the configured isolated in-memory database.

---

### Task 1: Coordinate Per-Connection Terminal Sizes

**Files:**
- Create: `internal/server/terminal_size.go`
- Create: `internal/server/terminal_size_test.go`

**Interfaces:**
- Produces: `terminalDimensions{Cols uint16, Rows uint16}`
- Produces: `newTerminalSizeCoordinator() *terminalSizeCoordinator`
- Produces: `(*terminalSizeCoordinator).subscribe(terminalID string, initial terminalDimensions, apply func(uint16, uint16, func()) error, publish ...func(terminalDimensions)) (report func(uint16, uint16) error, release func() error, updates <-chan terminalDimensions, unsubscribe func())`

- [ ] **Step 1: Write the failing minimum-and-disconnect test**

Create two subscribers for one terminal. Report `120x40`, then `80x24`, assert
both receive `80x24`, update the larger claim to `100x30` without another PTY
resize, then unsubscribe the smaller client and assert the PTY and remaining
client grow to `100x30`.

```go
func mustReport(t *testing.T, report func(uint16, uint16) error, cols, rows uint16) {
	t.Helper()
	if err := report(cols, rows); err != nil {
		t.Fatalf("report(%d, %d) error = %v", cols, rows, err)
	}
}

func mustReadDimensions(
	t *testing.T,
	updates <-chan terminalDimensions,
	want terminalDimensions,
) {
	t.Helper()
	if got := <-updates; got != want {
		t.Fatalf("dimensions = %#v, want %#v", got, want)
	}
}

func TestTerminalSizeCoordinatorUsesSmallestClaimAndGrowsAfterDisconnect(t *testing.T) {
	var applied []terminalDimensions
	apply := func(cols, rows uint16) error {
		applied = append(applied, terminalDimensions{Cols: cols, Rows: rows})
		return nil
	}
	coordinator := newTerminalSizeCoordinator()
	reportLarge, _, largeUpdates, stopLarge := coordinator.subscribe(
		"terminal", terminalDimensions{Cols: 80, Rows: 24}, apply,
	)
	defer stopLarge()
	reportSmall, _, smallUpdates, stopSmall := coordinator.subscribe(
		"terminal", terminalDimensions{Cols: 80, Rows: 24}, apply,
	)

	mustReport(t, reportLarge, 120, 40)
	mustReadDimensions(t, largeUpdates, terminalDimensions{Cols: 120, Rows: 40})
	mustReport(t, reportSmall, 80, 24)
	mustReadDimensions(t, largeUpdates, terminalDimensions{Cols: 80, Rows: 24})
	mustReadDimensions(t, smallUpdates, terminalDimensions{Cols: 80, Rows: 24})
	mustReport(t, reportLarge, 100, 30)
	stopSmall()
	mustReadDimensions(t, largeUpdates, terminalDimensions{Cols: 100, Rows: 30})

	wantApplied := []terminalDimensions{
		{Cols: 120, Rows: 40},
		{Cols: 80, Rows: 24},
		{Cols: 100, Rows: 30},
	}
	if !reflect.DeepEqual(applied, wantApplied) {
		t.Fatalf("applied dimensions = %#v, want %#v", applied, wantApplied)
	}
}
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
GOCACHE=/tmp/euphony-shared-size-go-cache go test ./internal/server -run TestTerminalSizeCoordinatorUsesSmallestClaimAndGrowsAfterDisconnect -count=1
```

Expected: compile failure because `terminalSizeCoordinator` does not exist.

- [ ] **Step 3: Implement the coordinator**

Use a mutex-protected map keyed by terminal ID. Each terminal entry contains
client claims, accepted-size publishers, the last accepted minimum, and the PTY
apply function. Validate each claim before storing it. Recompute the minimum
under the mutex and call `apply` once. The session wakes its PTY event actor,
which drains a bounded batch of readable bytes, applies the PTY size, and
invokes the publisher before reading again. This places the resize between pre-
and post-resize output without waiting for the terminal input lock.

- [ ] **Step 4: Add invalid-and-failed-apply tests**

Assert `0x24` and `1001x24` return the same bounds error used by the session
layer and publish nothing. Configure `apply` to fail for `80x24`, assert the
tentative size is not published, and prove a later valid update can still
succeed.

- [ ] **Step 5: Run coordinator tests and verify GREEN**

Run:

```bash
GOCACHE=/tmp/euphony-shared-size-go-cache go test ./internal/server -run TerminalSizeCoordinator -count=1
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/server/terminal_size.go internal/server/terminal_size_test.go
git commit -m "feat: coordinate shared terminal sizes"
```

### Task 2: Carry Accepted Sizes Through the Ordered WebSocket Stream

**Files:**
- Modify: `internal/server/server.go`
- Modify: `internal/server/terminal.go`
- Modify: `internal/server/terminal_test.go`

**Interfaces:**
- Consumes: `terminalSizeCoordinator.subscribe`
- Extends: `serverMessage` with `Cols uint16` and `Rows uint16`
- Produces: browser frame `{ "type": "resize", "cols": number, "rows": number }`

- [ ] **Step 1: Write the failing two-browser WebSocket test**

Create one terminal and two browser tickets, dial both sockets, drain each
through `history_end`, send `120x40` from the first and assert it receives
`resize 120x40`, then send `80x24` from the second and assert both receive
`resize 80x24`. Close the smaller socket and assert the first receives
`resize 120x40`.

- [ ] **Step 2: Run the integration test and verify RED**

Run with local-listener permission:

```bash
GOCACHE=/tmp/euphony-shared-size-go-cache go test ./internal/server -run TestTerminalWebSocketsShareSmallestSize -count=1
```

Expected: FAIL because no accepted resize frames are sent.

- [ ] **Step 3: Wire the coordinator into `Server`**

Initialize `terminalSizes` in `New`. For interactive terminal streams,
subscribe after WebSocket acceptance and defer unsubscribe. On a client
`resize`, call the report closure instead of `terminal.Resize` directly.
Read-only streams never subscribe.

- [ ] **Step 4: Serialize resize frames in the existing writer**

Extend the session subscriber queue with terminal events for both output bytes
and accepted sizes. Enqueue the accepted size from the PTY event actor, then
have the output goroutine consume that one event stream. Send the current PTY
size before history as every interactive browser's rendering baseline, and
continue sending accepted sizes to hidden/released browsers. Marshal resize
events as `serverMessage{Type: "resize", Cols: size.Cols, Rows: size.Rows}`.
Preserve the v1 base64 output envelope and include columns and rows there for
protocol consistency.

- [ ] **Step 5: Run server tests and verify GREEN**

Run:

```bash
GOCACHE=/tmp/euphony-shared-size-go-cache GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false go test ./internal/server ./internal/session
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/server/server.go internal/server/terminal.go internal/server/terminal_test.go
git commit -m "feat: broadcast accepted terminal size"
```

### Task 3: Measure Browser Capacity and Render Centered Letterboxing

**Files:**
- Modify: `web/src/components/TerminalView.tsx`
- Modify: `web/src/components/TerminalView.test.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- Extends `TerminalDriver` with:

```ts
proposeDimensions(): { cols: number; rows: number } | undefined;
resize(cols: number, rows: number): void;
```

- Consumes: server resize frames with `cols` and `rows`
- Produces: `data-local-cols`, `data-local-rows`, `data-shared-cols`, and `data-shared-rows` on `.terminal-view`

- [ ] **Step 1: Write failing capacity/accepted-size tests**

Use a fake driver where `proposeDimensions()` returns `120x40` and `resize` is
a spy. Assert socket open sends `120x40`. Deliver server `resize 80x24` and
assert `resize(80, 24)` is called without sending `80x24` back to the server.
Change proposed capacity to `100x30`, trigger ResizeObserver, and assert only
the local `100x30` claim is sent.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm --prefix web test -- --run src/components/TerminalView.test.tsx
```

Expected: compile or assertion failure because the driver cannot propose or
apply negotiated dimensions.

- [ ] **Step 3: Replace local fitting with capacity reporting**

Wrap `FitAddon.proposeDimensions()` and `Terminal.resize()` in the default
driver. Replace `terminal.fit()` calls used for layout sizing with
`reportCapacity()`. Keep visibility checks. On WebSocket open, report the
latest proposed dimensions. Remove the xterm `onResize` callback as a source of
capacity claims so accepted sizes cannot feed back into negotiation.

- [ ] **Step 4: Apply accepted server sizes**

Validate positive `cols` and `rows`, call `terminal.resize`, store the shared
size, and update the four diagnostic data attributes. Buffer initial history
and live output in one FIFO until this first accepted size is applied, and send
`resize_release` when the host becomes hidden. Bound the defensive pre-baseline
FIFO and close the socket on overflow.

- [ ] **Step 5: Write the failing centered-letterbox test**

Set the host rectangle to `1200x800`, local capacity to `120x40`, and accepted
size to `80x24`. Stub `.xterm-screen` to `800x480`. Assert the native-scale
xterm root is centered in the host without a dot overlay, and centering is
removed after an accepted `120x40` update.

- [ ] **Step 6: Implement centered letterboxing**

Measure the rendered `.xterm-screen` after `terminal.resize`, size the xterm
root to that native grid plus its viewport gutter, and center it with CSS.
Leave the surrounding host black and unmarked; do not scale the terminal.

- [ ] **Step 7: Run frontend tests, typecheck, and build**

Run:

```bash
npm --prefix web test -- --run src/components/TerminalView.test.tsx
npm --prefix web run typecheck
npm --prefix web run build
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add web/src/components/TerminalView.tsx web/src/components/TerminalView.test.tsx web/src/styles.css
git commit -m "feat: render shared terminal grid"
```

### Task 4: Verify Differently Sized Browsers End to End

**Files:**
- Modify: `web/e2e/terminal-reliability.spec.ts`

**Interfaces:**
- Consumes: `.terminal-view` local/shared data attributes
- Consumes: `.terminal-host[data-centered="true"]`

- [ ] **Step 1: Write the failing two-page Playwright test**

Open the same selected terminal in a `900x600` page and a `1400x900` page.
Wait for both connections, assert both pages report identical shared columns
and rows equal to the component-wise minimum of their local attributes, and
assert the larger page centers the xterm root. Close the smaller page, then
assert the larger page's shared attributes equal its local attributes and the
terminal returns to filling its host.

- [ ] **Step 2: Run the focused Playwright test**

Run:

```bash
EUPHONY_E2E_PORT=18092 npm --prefix web run e2e -- terminal-reliability.spec.ts --grep "shares the smallest terminal size"
```

Expected after Tasks 1-3: PASS; if it fails, use the trace and screenshot to
fix only observed integration issues.

- [ ] **Step 3: Run complete verification**

Run:

```bash
GOCACHE=/tmp/euphony-shared-size-go-cache GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false go test ./...
npm --prefix web test -- --run
npm --prefix web run typecheck
npm --prefix web run build
EUPHONY_E2E_PORT=18092 npm --prefix web run e2e
```

Expected: all commands PASS with one Playwright worker.

- [ ] **Step 4: Commit**

```bash
git add web/e2e/terminal-reliability.spec.ts
git commit -m "test: cover shared terminal size across browsers"
```
