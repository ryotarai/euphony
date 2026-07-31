# Terminal Exit Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Euphony on the nearest surviving terminal when the focused shell exits, while preserving intentional empty selections and active filters.

**Architecture:** Add an exit-specific reconciliation path to the shared selection domain and have the control service choose an adjacent session from ordered metadata. Reuse the same old-index-to-new-index rule in the browser's non-shared polling and local deletion paths; shared mode remains server-authoritative.

**Tech Stack:** Go, React 19, TypeScript, Vitest, Testing Library, Playwright.

## Global Constraints

- Do not alter the existing visual empty state or pane layout.
- Preserve active status/CWD filters and pinned terminals.
- Preserve explicit empty workspace selection.
- Write tests first, run the expected failure, then implement the smallest passing change.
- Keep all work in `tmp/worktrees/terminal-exit-fallback` and merge the verified commit back to `main`.

---

### Task 1: Reconcile a focused terminal exit in the selection domain

**Files:**
- Modify: `internal/selection/reducer.go`
- Test: `internal/selection/reducer_test.go`

**Interfaces:**
- Produces `ReconcileAfterTerminalDeletion(current State, previous Snapshot, deletedID string, replacementID string, terminals []Terminal) (State, bool)`.
- The function delegates normal stale-ID cleanup to `Reconcile`, then adds `replacementID` as an ordinary manual terminal only when `previous` contained exactly `deletedID`, no filters are active, and the cleaned snapshot is empty.

- [ ] **Step 1: Write the failing tests**

Add table-driven cases to `internal/selection/reducer_test.go`:

```go
func TestReconcileAfterTerminalDeletionSelectsReplacement(t *testing.T) {
	terminals := []Terminal{{ID: "next"}, {ID: "last"}}
	previous := Snapshot{TerminalIDs: []string{"deleted"}, FocusedTerminalID: "deleted"}
	state := State{ManualTerminalIDs: []string{"deleted"}, FocusedTerminalID: "deleted", Revision: 4}
	next, changed := ReconcileAfterTerminalDeletion(state, previous, "deleted", "next", terminals)
	if !changed || !reflect.DeepEqual(next.ManualTerminalIDs, []string{"next"}) || next.FocusedTerminalID != "next" {
		t.Fatalf("state = %#v, changed = %v", next, changed)
	}
}

func TestReconcileAfterTerminalDeletionKeepsIntentionalEmptySelection(t *testing.T) {
	state := State{Revision: 4}
	next, changed := ReconcileAfterTerminalDeletion(
		state,
		Snapshot{},
		"deleted",
		"next",
		[]Terminal{{ID: "next"}},
	)
	if changed || len(next.ManualTerminalIDs) != 0 || next.FocusedTerminalID != "" {
		t.Fatalf("state = %#v, changed = %v", next, changed)
	}
}
```

Also add a case with a non-empty `Snapshot.Filters` and assert the fallback
does not bypass that filter.

- [ ] **Step 2: Run the focused selection tests and verify RED**

Run `go test ./internal/selection -run 'TestReconcileAfterTerminalDeletion'`.
Expected: compilation failure because `ReconcileAfterTerminalDeletion` does not exist.

- [ ] **Step 3: Implement the minimal reconciliation function**

Implement the exact guard sequence in `internal/selection/reducer.go`:

```go
func ReconcileAfterTerminalDeletion(
	current State,
	previous Snapshot,
	deletedID, replacementID string,
	terminals []Terminal,
) (State, bool) {
	next, changed := Reconcile(current, terminals)
	if previous.FocusedTerminalID != deletedID ||
		!slices.Equal(previous.TerminalIDs, []string{deletedID}) ||
		replacementID == "" ||
		len(current.StatusFilters) > 0 || len(current.CWDFilters) > 0 ||
		len(current.PinnedFilters.Statuses) > 0 || len(current.PinnedFilters.CWDs) > 0 ||
		len(Resolve(next, terminals).TerminalIDs) > 0 {
		return next, changed
	}
	next.ManualTerminalIDs = []string{replacementID}
	next.FocusedTerminalID = replacementID
	if !changed {
		next.Revision = current.Revision + 1
	}
	return next, true
}
```

- [ ] **Step 4: Run the focused selection tests and verify GREEN**

Run `go test ./internal/selection -run 'TestReconcileAfterTerminalDeletion'`.
Expected: all new cases pass.

- [ ] **Step 5: Commit the domain change**

Run `git add internal/selection/reducer.go internal/selection/reducer_test.go && git commit -m "fix: retain selection after terminal exit"`.

### Task 2: Make the control service choose the adjacent replacement

**Files:**
- Modify: `internal/control/service.go`
- Test: `internal/control/selection_test.go`

**Interfaces:**
- Add an unexported `replacementTerminalID(deleted session.Metadata, remaining []session.Metadata) string` helper that assumes the existing `ListCurrent` creation order, prefers the first newer session, and otherwise returns the last older session.
- `Service.reconcileFromSessions` calls `selection.ReconcileAfterTerminalDeletion` only for `ChangeDeleted`; all other lifecycle reconciliation remains unchanged.

- [ ] **Step 1: Write the failing control-service test**

Add a test that creates three sessions, selects the middle one, deletes it through
`manager.Delete`, and asserts the published `selection.changed` snapshot focuses
the third session. Repeat with the third session and assert focus moves to the
second. Add an intentional empty-selection assertion to ensure deleting an
unselected session does not select a replacement.

- [ ] **Step 2: Run the focused control tests and verify RED**

Run `go test ./internal/control -run 'TestService.*Deletion'`.
Expected: the deletion test fails because the current service leaves the selection empty or focuses the first selected terminal.

- [ ] **Step 3: Implement ordered replacement and wire reconciliation**

Use the ordered metadata from `s.sessions.ListCurrent()` and `sort.Search` on
`CreatedAt`:

```go
func replacementTerminalID(deleted session.Metadata, remaining []session.Metadata) string {
	index := sort.Search(len(remaining), func(index int) bool {
		return !remaining[index].CreatedAt.Before(deleted.CreatedAt)
	})
	if index < len(remaining) {
		return remaining[index].ID
	}
	if len(remaining) == 0 {
		return ""
	}
	return remaining[len(remaining)-1].ID
}
```

Pass the result and the pre-change snapshot to the new selection reconciliation
function, then keep the existing revision/publish/save flow intact.

- [ ] **Step 4: Run the focused control tests and verify GREEN**

Run `go test ./internal/control -run 'TestService.*Deletion'`.
Expected: successor, predecessor, and intentional-empty cases pass.

- [ ] **Step 5: Run all Go tests**

Run `go test ./...`.
Expected: exit 0 with no failures.

- [ ] **Step 6: Commit the service change**

Run `git add internal/control/service.go internal/control/selection_test.go && git commit -m "fix: choose adjacent terminal after exit"`.

### Task 3: Apply the same adjacency rule to non-shared browser selection

**Files:**
- Modify: `web/src/App.tsx`
- Test: `web/src/App.test.tsx`

**Interfaces:**
- Add a small `replacementSession(previous, removedID, remaining)` helper that maps the removed session's old array index to `remaining[index]`, then `remaining[index - 1]`, then the first remaining session.
- Use it only when the selection becomes empty and no status/CWD filters are active.

- [ ] **Step 1: Write the failing App regression test**

Add a fake-timer test with URL `?terminal=session-3`, an initial list of
`session-1`, `session-2`, `session-3`, and a poll response without
`session-3`. Assert `session-2 terminal pane` is visible, the empty state is
absent, and the URL focus/terminal is `session-2`. Keep the existing final-pane
deselection test unchanged to cover intentional emptiness.

- [ ] **Step 2: Run the focused App test and verify RED**

Run `npm test -- --run src/App.test.tsx -t 'follows the previous terminal when the last terminal exits'` from `web`.
Expected: failure because the current cleanup chooses `sessions[0]` only when the selected ID is removed by a direct state update, and polling can leave the workspace empty/incorrectly focused.

- [ ] **Step 3: Implement the browser helper and use it in cleanup paths**

Track the last session ordering before each snapshot. In the existing
non-shared cleanup effect and `deleteSession`, replace `remaining[0]` with the
adjacent helper only when `statusFilters` and `cwdFilters` are empty. Preserve
the existing pin filtering, URL replacement, and explicit `allowEmpty` path.

- [ ] **Step 4: Run the focused App tests and verify GREEN**

Run `npm test -- --run src/App.test.tsx -t 'follows the previous terminal when the last terminal exits|pane rail checkboxes remove selected terminals and allow an empty workspace'`.
Expected: both the exit fallback and intentional empty-state tests pass.

- [ ] **Step 5: Run the full Web test suite and typecheck**

Run `npm test -- --run` and `npm run typecheck` from `web`.
Expected: exit 0 with no test failures or TypeScript errors.

- [ ] **Step 6: Commit the browser change**

Run `git add web/src/App.tsx web/src/App.test.tsx && git commit -m "fix(web): follow surviving terminal after exit"`.

### Task 4: Verify the complete feature and integrate the branch

**Files:**
- Verify: `internal/selection`, `internal/control`, `web/src/App.tsx`, and related tests.

- [ ] **Step 1: Run fresh complete verification**

Run `go test ./...`, `npm test -- --run`, `npm run typecheck`, and `npm run build`.
Expected: every command exits 0.

- [ ] **Step 2: Run the frontend smoke check**

Run the repository's Playwright command with its configured isolated test
server/database, or if no browser fixture can be started locally, record the
specific environment blocker and rely on the focused React behavior test.

- [ ] **Step 3: Inspect the diff and working tree**

Run `git diff --check`, `git status --short`, and `git log --oneline -4`.
Expected: only the intentional feature/docs commits are present in the
worktree and no whitespace errors are reported.

- [ ] **Step 4: Merge the verified branch back to main**

From the base checkout, run `git merge --ff-only codex/terminal-exit-fallback`.
Preserve unrelated base changes (`web/dist/.keep` deletion and `tmp/`) and
report the resulting commit.
