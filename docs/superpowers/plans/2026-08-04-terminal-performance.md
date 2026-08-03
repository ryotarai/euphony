# Terminal Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep terminal input and switching responsive as terminal count and session lifetime grow.

**Architecture:** Virtualize offscreen terminal content and retain only a four-terminal warm LRU. Return session snapshots immediately while slow metadata inspection runs single-flight outside locks shared with PTY input.

**Tech Stack:** React 19, TypeScript, xterm.js, Vitest, Playwright, Go 1.24, coder/websocket.

## Global Constraints

- Preserve terminal bytes losslessly and keep the existing history/live handoff protocol.
- Keep at most four non-selected warm terminal views mounted.
- Keep visible selected panes mounted; unmount selected panes outside the carousel viewport.
- Hidden warm panes must remain measurable but must not claim or resize the shared PTY.
- Do not change the existing visual design, selection, pinning, or source-tab behavior.
- Slow transcript reads and external `ps` execution must never hold locks needed by terminal input.
- Session-list requests must return the current snapshot without waiting for metadata refresh.
- Use TDD and record RED and GREEN evidence.

---

### Task 1: Bound and virtualize frontend terminal work

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/components/PaneCarousel.tsx`
- Modify: `web/src/components/PaneCarousel.test.tsx`
- Modify: `web/src/components/TerminalView.tsx`
- Modify: `web/src/components/TerminalView.test.tsx`
- Modify: `web/src/components/terminalUtils.ts`
- Modify: `web/src/components/terminalUtils.test.ts` if visibility behavior is extracted
- Modify: `web/e2e/terminal-reliability.spec.ts`

**Interfaces:**
- Produces: `maxCachedTerminalViews = 4` residency behavior.
- Produces: carousel content mounted exactly when `visible || cached`.
- Produces: a shared visibility predicate that treats `aria-hidden="true"` pane ancestors as non-visible.

- [ ] **Step 1: Add failing residency tests**

Extend the existing terminal lifetime test to visit at least six sessions and
assert no more than the current selected terminal plus four cached terminal
contents remain mounted. Preserve the existing A/B assertion that a recently
visited terminal mounts only once.

- [ ] **Step 2: Run the focused App test and verify RED**

Run:

```bash
npm test -- --run src/App.test.tsx
```

Expected: FAIL because all visited terminal probes remain mounted.

- [ ] **Step 3: Implement the bounded warm LRU**

Keep recency order by deleting and re-adding selected IDs. Derive cached panes
from only the four most recent non-selected IDs. Remove deleted session IDs and
trim old non-selected IDs from the retained set.

- [ ] **Step 4: Add failing carousel virtualization tests**

Assert an offscreen selected pane has no content, becomes mounted after carousel
navigation, and an explicitly cached pane remains mounted while invisible.

- [ ] **Step 5: Run the focused carousel test and verify RED**

Run:

```bash
npm test -- --run src/components/PaneCarousel.test.tsx
```

Expected: FAIL because every pane currently renders `pane.content`.

- [ ] **Step 6: Implement carousel virtualization and linear lookup**

Build a memoized `Map<string, number>` for displayed pane indices and render
content only for visible or cached panes. Preserve the pane wrapper so layout,
ARIA, and navigation operate on the complete selected list.

- [ ] **Step 7: Add failing hidden-capacity tests**

Assert a terminal beneath `aria-hidden="true"` neither refreshes nor proposes
dimensions and releases a previous resize claim when it becomes hidden.

- [ ] **Step 8: Run the focused TerminalView tests and verify RED**

Run:

```bash
npm test -- --run src/components/TerminalView.test.tsx
```

Expected: FAIL because current visibility checks only inspect `hidden`.

- [ ] **Step 9: Suppress hidden terminal geometry work**

Use one visibility predicate for fit, refresh, and capacity reporting. Avoid
`setLocalSize` when dimensions are unchanged.

- [ ] **Step 10: Verify frontend behavior**

Run:

```bash
npm test -- --run
npm run typecheck
npm run build
npx playwright test e2e/terminal-reliability.spec.ts --workers=1
```

- [ ] **Step 11: Commit**

```bash
git add web
git commit -m "perf(web): bound terminal rendering work"
```

### Task 2: Remove backend metadata work from the input path

**Files:**
- Modify: `internal/session/foreground_unix.go`
- Modify: `internal/session/manager.go`
- Modify: `internal/session/session.go`
- Modify: `internal/session/manager_test.go`
- Modify: `internal/server/sessions.go`
- Modify: `internal/server/sessions_test.go`

**Interfaces:**
- Produces: `(*Manager).RefreshMetadata()` as non-blocking single-flight refresh.
- Preserves: `(*Manager).List()` synchronous refresh semantics.
- Consumes: `(*Manager).ListCurrent()` for immediate HTTP responses.

- [ ] **Step 1: Add a failing foreground lock concurrency test**

Call a helper with a runner that blocks after the PTY foreground group is
captured. While the runner is blocked, write through the session's terminal
file and require the write to complete before releasing the runner.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
go test ./internal/session -run 'TestForegroundCommandDoesNotBlockTerminalWrite' -count=1
```

Expected: FAIL by timeout because `ForegroundCommand` holds `fileMu` during the
runner.

- [ ] **Step 3: Narrow the foreground lock**

Under `fileMu`, validate the session and read the foreground process group.
Release `fileMu` before invoking `ps`. Keep the production method calling the
real command and make the runner-injected helper package-private.

- [ ] **Step 4: Add a failing Codex title lock concurrency test**

Use a gated title resolver or FIFO transcript so title resolution is known to
be blocked. While it is blocked, require `Metadata()` to return immediately.
Then release resolution and assert the title update is applied only to the same
agent session and transcript.

- [ ] **Step 5: Run the focused test and verify RED**

Run:

```bash
go test ./internal/session -run 'TestRefreshCodexTitlesDoesNotBlockMetadata' -count=1
```

Expected: FAIL by timeout because transcript scanning currently holds `m.mu`.

- [ ] **Step 6: Move title resolution outside the manager lock**

Snapshot candidate identity and header-scan state under the lock, resolve the
title outside it, then re-lock and apply only if ID, agent session, and
transcript path still match. Keep store writes limited to actual title changes.

- [ ] **Step 7: Add failing asynchronous list tests**

Block metadata refresh, issue `GET /api/sessions`, and assert the response
returns the current in-memory snapshot before the refresh is released. Issue an
overlapping request and assert only one refresh is active.

- [ ] **Step 8: Run the focused server test and verify RED**

Run:

```bash
go test ./internal/server -run 'TestListSessionsDoesNotWaitForMetadataRefresh' -count=1
```

Expected: FAIL because the handler currently calls synchronous `List()`.

- [ ] **Step 9: Implement single-flight asynchronous refresh**

Guard refresh work with `sync.Mutex.TryLock`. Let `List()` acquire the refresh
and execute synchronously when available, preserving current callers. Add an
async trigger used by the HTTP handler, which writes `ListCurrent()` first and
does not enqueue duplicate refresh goroutines.

- [ ] **Step 10: Add a failing PTY drain regression test**

Exercise a readable PTY until it is drained, then submit a resize and require
the resize to complete. The test must fail by blocked pump or timeout before the
descriptor is made non-blocking.

- [ ] **Step 11: Make PTY draining non-blocking**

Set the PTY descriptor non-blocking during session startup. Treat `EAGAIN` and
`EWOULDBLOCK` as a normal end of the current drain batch, while preserving EOF
and real error handling.

- [ ] **Step 12: Verify backend behavior**

Run:

```bash
go test ./internal/session ./internal/server -count=1
go test -race ./internal/session ./internal/server -count=1
go test ./... -count=1
```

- [ ] **Step 13: Commit**

```bash
git add internal/session internal/server
git commit -m "perf: isolate terminal input from metadata refresh"
```

### Task 3: Integrated verification and performance guardrails

**Files:**
- Modify only if integration findings require a focused regression test.

**Interfaces:**
- Consumes the bounded frontend residency and non-blocking backend refresh.

- [ ] **Step 1: Verify the combined diff**

Run:

```bash
go test ./... -count=1
cd web && npm test -- --run && npm run typecheck && npm run build
```

- [ ] **Step 2: Run browser reliability coverage with isolated state**

Run the existing Playwright configuration, which uses one worker and an
isolated test database:

```bash
cd web && npx playwright test e2e/terminal-reliability.spec.ts --workers=1
```

- [ ] **Step 3: Inspect resource bounds**

Confirm tests assert that visited terminal content, sockets, observers, and
geometry callbacks plateau at the selected-visible count plus four warm panes.

- [ ] **Step 4: Commit integration-only fixes if needed**

```bash
git add .
git commit -m "test: cover terminal performance bounds"
```
