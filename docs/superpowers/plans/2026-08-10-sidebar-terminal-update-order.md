# Sidebar Terminal Update Order Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Order sidebar terminal rows by attention/status priority and newest persisted session metadata update.

**Architecture:** Extend `session.Metadata` with a persisted `UpdatedAt` timestamp. The manager stamps every `ChangeUpdated` record centrally, the SQLite store migrates and round-trips it, and `SessionNavigation` applies a stable two-key comparator inside each existing cwd group.

**Tech Stack:** Go 1.24, SQLite, React 19, TypeScript, Testing Library, Vitest, Vite, and the existing Playwright setup.

## Global Constraints

- Preserve cwd groups in first-seen order.
- Preserve the priority `needs attention > blocked > running > waiting > terminal > other`.
- Sort equal-priority rows by newest effective update timestamp first.
- Preserve input order when priority and timestamp are equal.
- Keep attention independent from lifecycle status and selection behavior.
- Treat a missing or invalid client timestamp as `createdAt`.
- Keep legacy databases readable by falling back from empty `updated_at` to `created_at`.

---

### Task 1: Specify persisted session update timestamps

**Files:**
- Modify: `internal/session/manager_test.go`
- Modify: `internal/session/sqlite_store_test.go`
- Modify: `web/src/components/SessionNavigation.test.tsx`

**Interfaces:**
- Consumes: existing session creation, agent update, SQLite store, and sidebar rendering APIs.
- Produces: failing tests that require `UpdatedAt` / `updatedAt` and the requested ordering contract.

- [ ] **Step 1: Add the manager timestamp regression test**

Create a session, retain its `UpdatedAt`, call `UpdateAgent` with a status
change, and assert that the returned timestamp is non-zero and later than the
creation timestamp.

```go
func TestManagerUpdatesMetadataUpdatedAt(t *testing.T) {
	manager := NewManager("/bin/sh")
	t.Cleanup(func() { _ = manager.Close(context.Background()) })

	created, err := manager.Create(context.Background(), "Terminal", t.TempDir())
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	updated, err := manager.UpdateAgent(created.ID, AgentUpdate{
		Agent: "claude", Status: "waiting",
	})
	if err != nil {
		t.Fatalf("UpdateAgent() error = %v", err)
	}
	if updated.UpdatedAt.IsZero() || !updated.UpdatedAt.After(created.UpdatedAt) {
		t.Fatalf("UpdatedAt = %v, want after %v", updated.UpdatedAt, created.UpdatedAt)
	}
}
```

- [ ] **Step 2: Extend the SQLite round-trip and migration expectations**

Set a concrete `UpdatedAt` in `TestSQLiteStorePersistsTerminalMetadata`, include
it in `metadataEqual`, and assert that a legacy row with no `updated_at`
column reads its `created_at` as `UpdatedAt`.

- [ ] **Step 3: Extend the sidebar ordering test**

Render multiple rows in one cwd with mixed input order. Include attention,
blocked, running, and waiting rows with both older and newer `updatedAt`
values. Assert the exact rendered button order:

```tsx
expect([...labels].map((button) => button.getAttribute("aria-label"))).toEqual([
	"Select New attention",
	"Select Old attention",
	"Select New blocked",
	"Select New running",
	"Select Old running",
	"Select New waiting",
	"Select Old waiting",
]);
```

- [ ] **Step 4: Run the new tests to verify they fail**

Run:

```bash
go test ./internal/session -run 'TestManagerUpdatesMetadataUpdatedAt|TestSQLiteStore'
cd web && npm test -- --run src/components/SessionNavigation.test.tsx
```

Expected: the Go tests fail to compile because `Metadata.UpdatedAt` is not
defined, and the web test fails because rows do not yet compare `updatedAt`.

- [ ] **Step 5: Commit the failing specifications**

```bash
git add internal/session/manager_test.go internal/session/sqlite_store_test.go web/src/components/SessionNavigation.test.tsx
git commit -m "test: specify sidebar terminal update ordering"
```

### Task 2: Add and persist `UpdatedAt` metadata

**Files:**
- Modify: `internal/session/manager.go`
- Modify: `internal/session/sqlite_store.go`
- Modify: `internal/server/openapi.json`

**Interfaces:**
- Consumes: the failing manager and SQLite tests from Task 1.
- Produces: `session.Metadata.UpdatedAt time.Time` serialized as `updatedAt` and persisted in `terminals.updated_at`.

- [ ] **Step 1: Add the metadata field and initialize new sessions**

Add:

```go
UpdatedAt time.Time `json:"updatedAt"`
```

Set `CreatedAt` once in `Manager.Create` and use the same value for
`UpdatedAt`. Keep restore behavior from changing every restored row's update
time; old rows with an empty timestamp are normalized to their creation time
when loaded or saved.

- [ ] **Step 2: Stamp `ChangeUpdated` centrally**

In `nextChangeLocked`, when `kind == ChangeUpdated` and `after != nil`, assign
`time.Now().UTC()` to both `after.UpdatedAt` and the matching live session's
metadata. This keeps all existing metadata mutation paths covered, including
agent transitions, attention acknowledgement, cwd refresh, foreground process
labels, title refreshes, and rename.

- [ ] **Step 3: Migrate and read the SQLite column**

Add `updated_at TEXT NOT NULL DEFAULT ''` to the create-table schema. Add an
`ALTER TABLE` migration when the column is absent. Select and parse it in
`Load`; if it is empty, assign `CreatedAt`. Return a clear parse error for a
non-empty invalid timestamp.

- [ ] **Step 4: Write the SQLite column**

Add `updated_at` to `Save`'s insert/upsert. Normalize a zero in-memory value to
`CreatedAt` before formatting so test doubles and old callers remain safe.

- [ ] **Step 5: Document the API field**

Add `updatedAt` to the OpenAPI `Terminal` schema as a required date-time
property alongside `createdAt`.

- [ ] **Step 6: Run the backend tests**

Run:

```bash
gofmt -w internal/session/manager.go internal/session/sqlite_store.go internal/session/manager_test.go internal/session/sqlite_store_test.go
go test ./internal/session
```

Expected: all session tests pass, including the new timestamp and legacy
migration coverage.

- [ ] **Step 7: Commit the backend metadata change**

```bash
git add internal/session/manager.go internal/session/sqlite_store.go internal/session/manager_test.go internal/session/sqlite_store_test.go internal/server/openapi.json
git commit -m "feat: track terminal metadata update time"
```

### Task 3: Sort sidebar rows by newest update within priority

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/components/SessionNavigation.tsx`
- Modify: `web/src/components/SessionNavigation.test.tsx`

**Interfaces:**
- Consumes: API sessions with `updatedAt` and the existing `terminalPriority` function.
- Produces: stable cwd-local row ordering with attention/status priority and descending update time.

- [ ] **Step 1: Add the client timestamp compatibility field**

Add `updatedAt?: string` to `Session` so older snapshots and existing test
fixtures remain renderable while production responses use the new field.

- [ ] **Step 2: Add an effective timestamp helper and comparator**

Use `Date.parse(session.updatedAt ?? session.createdAt)` and return `0` for an
invalid result. Compare priority first, then compare right timestamp minus
left timestamp so newer rows sort first. Return `0` for ties and keep the
existing copied array sort, preserving stable input order.

```tsx
function terminalUpdatedAt(session: Session) {
  const timestamp = Date.parse(session.updatedAt ?? session.createdAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function compareTerminalRows(left: Session, right: Session) {
  const priority = terminalPriority(left) - terminalPriority(right);
  if (priority !== 0) return priority;
  return terminalUpdatedAt(right) - terminalUpdatedAt(left);
}
```

- [ ] **Step 3: Use the comparator inside each cwd group**

Replace the priority-only sort callback in `groupSessionsByCwd` with
`compareTerminalRows`. Leave the outer cwd map iteration untouched.

- [ ] **Step 4: Run the focused web test**

Run:

```bash
cd web && npm test -- --run src/components/SessionNavigation.test.tsx
```

Expected: all `SessionNavigation` tests pass, including the exact attention,
status, and newest-update order assertion.

- [ ] **Step 5: Commit the sidebar behavior**

```bash
git add web/src/types.ts web/src/components/SessionNavigation.tsx web/src/components/SessionNavigation.test.tsx
git commit -m "fix: sort sidebar terminals by recent update"
```

### Task 4: Verify and integrate

**Files:**
- No additional files.

**Interfaces:**
- Consumes: the completed metadata and sidebar changes.
- Produces: test, type, build, browser, diff, and merge evidence.

- [ ] **Step 1: Run focused verification**

```bash
go test ./internal/session ./internal/server
cd web && npm test -- --run src/components/SessionNavigation.test.tsx
```

- [ ] **Step 2: Run the full suites and static checks**

```bash
go test ./...
cd web && npm test -- --run
npm run typecheck
npm run build
```

Record unrelated baseline failures without weakening the new focused tests.

- [ ] **Step 3: Run the isolated browser suite**

```bash
cd web && EUPHONY_E2E_PORT=18081 npm run e2e -- --workers=1
```

The existing Playwright configuration uses an in-memory database and
port-specific socket/config paths; keep the single worker so browser actions
cannot race shared server state.

- [ ] **Step 4: Inspect the final diff**

```bash
git diff --check HEAD~3..HEAD
git status --short --branch
git log -3 --oneline
```

Confirm that only the design/plan documents, session metadata changes, API
schema, and sidebar tests/source are part of the branch.

- [ ] **Step 5: Merge the verified branch into the base branch**

From the base checkout, merge `fix/sidebar-terminal-update-order` with a
fast-forward merge when possible. Preserve unrelated base changes such as the
existing `web/dist/.keep` deletion and untracked `tmp/` contents.
