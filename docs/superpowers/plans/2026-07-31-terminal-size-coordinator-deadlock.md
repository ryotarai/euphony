# Terminal Size Coordinator Deadlock Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a blocking PTY resize for one terminal from holding the global terminal-size coordinator mutex and freezing unrelated control WebSockets.

**Architecture:** Keep the coordinator mutex for the terminal group map and global client IDs only. Add a mutex and operation reference count to each terminal group, and hold that group mutex across synchronous resize application and rollback so same-terminal transactions remain ordered without cross-terminal blocking.

**Tech Stack:** Go 1.24, standard `sync` primitives, Go `testing` package.

## Global Constraints

- Preserve smallest-columns/smallest-rows claim selection.
- Preserve synchronous `apply` errors and rollback semantics.
- Never hold the coordinator mutex while waiting for PTY resize completion.
- Keep work isolated in `tmp/worktrees/fix-terminal-size-coordinator`.

---

### Task 1: Add a cross-terminal blocking regression test

**Files:**
- Modify: `internal/server/terminal_size_test.go`

**Interfaces:**
- Consumes: `newTerminalSizeCoordinator`, `subscribe`, and terminal dimension update channels.
- Produces: A test proving that one terminal's blocked `apply` does not block another terminal's `report`.

- [ ] **Step 1: Write the failing test**

Add `TestTerminalSizeCoordinatorDoesNotBlockDifferentTerminalsWhileResizeIsPending`.
Use `apply` to block only terminal A after signaling `applyStarted`, and use a
second `apply` for terminal B that calls `notify` immediately. Start A's
`report` in a goroutine, wait for `applyStarted`, then call B's `report` in a
goroutine and require it to return within 100 milliseconds. Read B's accepted
dimensions to prove the transaction completed, release A, and assert A's
goroutine returns without error.

```go
func TestTerminalSizeCoordinatorDoesNotBlockDifferentTerminalsWhileResizeIsPending(t *testing.T) {
	applyStarted := make(chan struct{})
	releaseApply := make(chan struct{})
	apply := func(terminal string) func(uint16, uint16, func()) error {
		return func(cols, rows uint16, notify func()) error {
			if terminal == "a" {
				close(applyStarted)
				<-releaseApply
			}
			notify()
			return nil
		}
	}
	coordinator := newTerminalSizeCoordinator()
	reportA, _, _, stopA := coordinator.subscribe("a", terminalDimensions{Cols: 80, Rows: 24}, apply("a"))
	defer stopA()
	reportB, _, updatesB, stopB := coordinator.subscribe("b", terminalDimensions{Cols: 80, Rows: 24}, apply("b"))
	defer stopB()

	aDone := make(chan error, 1)
	go func() { aDone <- reportA(120, 40) }()
	select {
	case <-applyStarted:
	case <-time.After(time.Second):
		t.Fatal("terminal A resize did not start")
	}

	bDone := make(chan error, 1)
	go func() { bDone <- reportB(100, 30) }()
	select {
	case err := <-bDone:
		if err != nil {
			t.Fatalf("terminal B report error = %v", err)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("terminal B report was blocked by terminal A resize")
	}
	if got := readTerminalDimensions(t, updatesB); got != (terminalDimensions{Cols: 100, Rows: 30}) {
		t.Fatalf("terminal B dimensions = %#v, want 100x30", got)
	}
	close(releaseApply)
	select {
	case err := <-aDone:
		if err != nil {
			t.Fatalf("terminal A report error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("terminal A report did not finish after release")
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
go test ./internal/server -run TestTerminalSizeCoordinatorDoesNotBlockDifferentTerminalsWhileResizeIsPending -count=1
```

Expected: FAIL with `terminal B report was blocked by terminal A resize`.

### Task 2: Isolate coordinator operations per terminal group

**Files:**
- Modify: `internal/server/terminal_size.go`

**Interfaces:**
- Consumes: Existing coordinator `subscribe`, `report`, `release`, and `unsubscribe` calls.
- Produces: The same public closures and errors, with group-local synchronization and safe cleanup.

- [ ] **Step 1: Add group synchronization state**

Add `mu sync.Mutex` and `operations int` to `terminalSizeGroup`. Keep
`terminalSizeCoordinator.mu` for the group map and `nextID` only.

- [ ] **Step 2: Add group reference helpers**

Implement helpers that increment a group's `operations` count while looking it
up under `c.mu`, and decrement it after the group operation. Remove the group
from `c.groups` only when its client map is empty and its operation count is
zero. Return the existing closed-subscription error when the group or client
does not exist.

- [ ] **Step 3: Update subscribe, report, release, and unsubscribe**

Acquire a group reference before locking `group.mu`; release the reference on
every return path. Move all client/accepted state access under `group.mu`.
Do not hold `c.mu` while acquiring `group.mu` or invoking `group.apply`.
Keep `group.mu` held across `apply` and rollback so same-terminal operations
remain serialized.

- [ ] **Step 4: Run the focused regression and existing coordinator tests**

Run:

```bash
go test ./internal/server -run 'TestTerminalSizeCoordinator' -count=1
```

Expected: PASS, including the new cross-terminal test and all existing claim,
validation, rollback, release, and notification tests.

### Task 3: Verify concurrency safety and repository behavior

**Files:**
- No additional files.

- [ ] **Step 1: Run the race detector for the affected package**

Run `go test -race ./internal/server -run 'TestTerminal(SizeCoordinator|WebSocket)' -count=1`.
Expected: PASS with no race reports.

- [ ] **Step 2: Run the full Go test suite**

Run `go test ./...`.
Expected: PASS for every package.

- [ ] **Step 3: Review the diff and commit**

Run `git diff --check`, inspect `git diff`, then commit the design, plan, test,
and implementation with:

```bash
git add docs/superpowers/specs/2026-07-31-terminal-size-coordinator-deadlock-design.md docs/superpowers/plans/2026-07-31-terminal-size-coordinator-deadlock.md internal/server/terminal_size.go internal/server/terminal_size_test.go
git commit -m "fix: isolate terminal size coordination locks"
```
