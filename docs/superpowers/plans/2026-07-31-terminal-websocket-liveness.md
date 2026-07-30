# Terminal WebSocket Liveness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expire silent terminal WebSocket connections so their shared-size claims cannot remain indefinitely.

**Architecture:** Add a server-side protocol Ping/Pong monitor with fixed production timing and injectable test timing. A liveness failure cancels the terminal handler context and relies on its existing deferred size-unsubscribe path.

**Tech Stack:** Go, `github.com/coder/websocket`, Go `testing`

## Global Constraints

- Use WebSocket protocol Ping/Pong rather than a JavaScript heartbeat.
- Do not add or change the application WebSocket message schema.
- Keep normal terminal sessions running when one browser connection expires.
- Do not log terminal bytes, authentication tokens, or credentials.

---

### Task 1: Terminal WebSocket liveness monitor

**Files:**
- Modify: `internal/server/terminal.go`
- Modify: `internal/server/terminal_test.go`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: `(*websocket.Conn).Ping(context.Context) error`
- Produces: `monitorTerminalWebSocket(ctx context.Context, interval time.Duration, timeout time.Duration, ping func(context.Context) error) error`

- [ ] **Step 1: Write failing liveness tests**

Add tests that use channels and short explicit durations to verify a successful
Ping repeats, a failed Ping returns its error, and parent cancellation stops the
monitor without reporting a failure.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `go test ./internal/server -run 'TestMonitorTerminalWebSocket' -count=1`

Expected: build failure because `monitorTerminalWebSocket` does not exist.

- [ ] **Step 3: Implement the minimal monitor and handler integration**

Implement a ticker-driven monitor. Give each Ping a child context with a
5-second timeout. Start it for every accepted terminal WebSocket and cancel the
handler context only when monitoring returns a non-cancellation error.

- [ ] **Step 4: Run focused and package tests**

Run:

```bash
go test ./internal/server -run 'TestMonitorTerminalWebSocket|TestTerminalWebSocketsShareSmallestSize' -count=1
go test ./internal/server
```

Expected: all tests pass.

- [ ] **Step 5: Record the reusable reliability rule**

Add an `AGENTS.md` rule requiring server-driven WebSocket Ping/Pong to bound
the lifetime of browser-owned terminal claims.

- [ ] **Step 6: Run full verification**

Run:

```bash
go test ./...
cd web && npm test -- --run && npm run typecheck
```

Expected: all tests and type checks pass.

- [ ] **Step 7: Commit**

```bash
git add AGENTS.md internal/server/terminal.go internal/server/terminal_test.go docs/superpowers/specs/2026-07-31-terminal-websocket-liveness-design.md docs/superpowers/plans/2026-07-31-terminal-websocket-liveness.md
git commit -m "fix: expire stale terminal connections"
```
