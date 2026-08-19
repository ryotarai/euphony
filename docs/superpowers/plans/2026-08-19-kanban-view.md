# Kanban View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a low-cognitive-load Kanban modal for live agent sessions with a persisted Archived column, a sidebar entry, a keyboard shortcut, and restore access through All sessions.

**Architecture:** Persist `archived` on terminal metadata and filter it out of the normal session list. Extend All sessions to identify archived records, then compose a Kanban view from live sessions, archived All-session records, and the latest agent summaries. Keep live status projection read-only; only archive/restore is user controlled. The implementation exposes dedicated Kanban list endpoints and a terminal/agent-session archive mutation so All sessions can remain the complete recovery index.

**Tech Stack:** Go HTTP server, SQLite terminal metadata, React 19, Vitest/Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-19-kanban-view-design.md`

## Global Constraints

- Keep the four fixed columns in the order Running, Waiting, Blocked, Archived.
- Keep the modal at approximately 80vw by 80dvh with small-screen fallbacks.
- Put Kanban immediately above All sessions in the sidebar footer.
- Use Meta+Shift+K and Ctrl+Shift+K, ignoring editable targets.
- Let users drag only into Archived and provide Archive/Restore button fallbacks.
- Preserve archived records in All sessions and keep existing resume behavior safe.
- Write failing tests before production code and verify the red-green cycle.
- Preserve unrelated dirty files in the base checkout; all edits happen in this feature worktree or isolated child worktrees.

---

### Task 1: Persist the archive flag and expose archive mutations

**Files:**
- Modify: `internal/session/manager.go`
- Modify: `internal/session/sqlite_store.go`
- Modify: `internal/server/kanban.go`
- Modify: `internal/server/all_sessions.go`
- Modify: `internal/server/server.go`

**Interfaces:**
- Produces `Metadata.Archived bool`, `Manager.SetAgentSessionArchived(terminalID, agentSessionID string, archived bool) (Metadata, error)`, and `PATCH /api/kanban/sessions/{terminalID}/{agentSessionID}` accepting `{ "archived": boolean }`.
- `Manager.ListCurrent` excludes archived metadata; `ListStored` and `ListPersisted` retain it.
- The endpoint returns updated agent-session metadata and rejects unknown or non-agent identities.

- [ ] **Step 1: Write the failing persistence and endpoint tests**

Create fixtures that set an agent on a persistent terminal, call the archive
mutation, verify the active list no longer includes it, close/reopen the
SQLite-backed manager, and verify the archived flag is still true. Add a
non-agent rejection test and an unarchive test.

- [ ] **Step 2: Run the focused Go tests and verify they fail for missing archive behavior**

Run `go test ./internal/session ./internal/server -run 'Archive|Archived' -count=1`.
Expected: compilation or assertion failures because `Archived` and the
archive endpoint do not exist yet.

- [ ] **Step 3: Implement the minimal metadata, migration, manager, and route changes**

Add an `archived` SQLite column with a default of zero and an idempotent
migration for existing databases. Persist the field in every terminal load
and save. Implement a serialized metadata update that emits a normal update
event, keeps explicit deletion destructive, and filters only archived items
from `ListCurrent`. Register the route and validate the agent/session.

- [ ] **Step 4: Run focused tests, then the relevant Go packages**

Run the focused command again, then `go test ./internal/session ./internal/server`.
Expected: all tests pass with zero failures.

- [ ] **Step 5: Commit the backend contract**

Run `gofmt -w internal/session/manager.go internal/session/sqlite_store.go internal/session/manager_test.go internal/server/sessions.go internal/server/server.go internal/server/sessions_test.go`, then commit with `feat: persist archived agent sessions`.

### Task 2: Preserve archived sessions in All sessions

**Files:**
- Modify: `internal/server/all_sessions.go`
- Modify: `internal/server/all_sessions_test.go`
- Modify: `web/src/types.ts`
- Modify: `web/src/api.ts`
- Modify: `web/src/api.test.ts`

**Interfaces:**
- `AllSession` gains `archived: boolean` while retaining the existing `"open" | "resume"` state semantics.
- `GET /api/all-sessions` includes archived records with `archived: true` and retains `terminalId` for managed records.
- `ApiClient` exposes `listKanbanSessions`, `listKanbanArchives`, and `setKanbanSessionArchived`.

- [ ] **Step 1: Add failing list/API tests**

Add a server fixture whose live agent metadata is archived and assert the All
sessions response contains one archived item while the normal session list
does not. Add a client test asserting the exact JSON body and decoded session.

- [ ] **Step 2: Run the focused Go and Vitest tests to verify the red state**

Run `go test ./internal/server -run 'AllSessions|Archive' -count=1` and
`npm test -- --run src/api.test.ts -t 'archive'` from `web`.
Expected: the new assertions fail because the state and client method are
missing.

- [ ] **Step 3: Implement archived All-session mapping and the API method**

Keep archived agent sessions in the DB-only All sessions index, preserve the
existing open/exited merge rules, and make the API method use the exact
boolean payload.

- [ ] **Step 4: Run focused tests and web typecheck**

Run the two focused commands again and `npm run typecheck` from `web`.
Expected: all pass.

- [ ] **Step 5: Commit the All sessions compatibility layer**

Commit with `feat: expose archived sessions to all sessions`.

### Task 3: Build the Kanban modal and navigation entry

**Files:**
- Create: `web/src/components/KanbanDialog.tsx`
- Create: `web/src/components/KanbanDialog.test.tsx`
- Modify: `web/src/components/SessionNavigation.tsx`
- Modify: `web/src/components/SessionNavigation.test.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- `KanbanDialog` accepts `sessions`, `loading`, `error`, `onOpenChange`, `onArchiveSession`, and `onRestoreSession` callbacks.
- It renders fixed `Running`, `Waiting`, `Blocked`, and `Archived` headings with counts.
- SessionNavigation accepts `onOpenKanban` and renders the Kanban button directly above All sessions with an `aria-keyshortcuts` hint.

- [ ] **Step 1: Write failing component/navigation tests**

Cover fixed columns, status projection, concise card content, `80vw`/`80dvh`
class hooks, Archive and Restore fallback buttons, `dragStart` + drop into
Archived, and sidebar order/shortcut attributes.

- [ ] **Step 2: Run the focused tests and verify the expected failures**

Run `npm test -- --run src/components/KanbanDialog.test.tsx src/components/SessionNavigation.test.tsx` from `web`.
Expected: the new component/import/prop assertions fail before implementation.

- [ ] **Step 3: Implement the modal and visual system**

Use the existing dialog and button primitives. Keep all four columns mounted,
give each column an independent scroll region, accept native drops only on
Archived, and expose equivalent keyboard action buttons. Use the existing
graphite/pale-text/lime palette with a single
status accent per column; add reduced-motion and narrow-screen rules.

- [ ] **Step 4: Run focused component tests and typecheck**

Run the focused Vitest command and `npm run typecheck` from `web`.
Expected: all pass.

- [ ] **Step 5: Commit the UI surface**

Commit with `feat: add kanban session board`.

### Task 4: Connect App state, shortcut, archive, restore, and All sessions

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/types.ts` if the composed item type needs a shared definition

**Interfaces:**
- App owns `kanbanOpen`, loading/error state, and the in-flight archive ID.
- Live items use Kanban agent-session records plus the latest non-done `AgentSummary`; archived items use the archive endpoint records.
- Opening Kanban loads active and archived snapshots. Archive refreshes the normal session list and both board snapshots. Restore refreshes the live snapshot and focuses the restored terminal.

- [ ] **Step 1: Write failing App tests**

Add tests for the shortcut/button opening the board, an agent card moving to
Archived and disappearing from the sidebar after a successful API response,
restore reappearing and focusing the session, All sessions opening an
archived record through the same restore path, and a failed mutation leaving
the board open with the error.

- [ ] **Step 2: Run focused App tests to confirm the red state**

Run `npm test -- --run src/App.test.tsx -t 'Kanban|archived|Archive'` from
`web`. Expected: the new tests fail because App does not own Kanban state or
the shortcut yet.

- [ ] **Step 3: Implement the App integration**

Add the modal state and load effect, derive a stable item list and status
columns without duplicating status state, add Meta/Ctrl+Shift+K handling that
respects editable targets, archive/restore callbacks with stale-response
guards, and extend All sessions selection for `state: "archived"`.

- [ ] **Step 4: Run focused tests, then the complete web suite**

Run the focused App tests, `npm test -- --run`, `npm run typecheck`, and
`npm run build` from `web`. Expected: all pass.

- [ ] **Step 5: Commit the application integration**

Commit with `feat: connect kanban session lifecycle`.

### Task 5: End-to-end verification and integration

- [ ] **Step 1: Run formatting and diff checks**

Run `gofmt -w` on all changed Go files and `git diff --check`.

- [ ] **Step 2: Run full backend and frontend verification**

Run `go test ./...`, `npm test -- --run`, `npm run typecheck`, and
`npm run build` from `web`.

- [ ] **Step 3: Exercise the UI with isolated Playwright state**

Run the existing E2E harness with its isolated database and port. Verify the
Kanban button, shortcut, modal geometry, archive drop/fallback, sidebar
removal, All sessions visibility, and restore behavior. If the harness cannot
create an agent fixture without credentials, run the strongest available
component/App tests and record that limitation.

- [ ] **Step 4: Review the complete diff and commit final fixes**

Check that no unrelated files changed, that all four columns remain stable on
empty data, and that archived state survives a restart. Commit any fixes.

- [ ] **Step 5: Merge into the base branch**

After verification, merge `feature/kanban-view` into `main` without touching
the base checkout's pre-existing dirty files.
