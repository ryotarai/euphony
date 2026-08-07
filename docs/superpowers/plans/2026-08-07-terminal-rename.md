# Terminal Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the focused selected terminal from Quick Actions, persist the name, and display it in the sidebar.

**Architecture:** Add a `customName` metadata marker and a PATCH v1 endpoint backed by the existing session manager/SQLite change pipeline. Add a frontend API method and dialog; the successful response updates local sessions immediately while the existing terminal update event synchronizes other clients.

**Tech Stack:** Go, SQLite, net/http, React 19, TypeScript, Vitest, Testing Library, Playwright.

## Global Constraints

- Names are trimmed and must contain 1–80 characters in both UI and server validation.
- Only the focused selected terminal is renamed; multiple selected panes are never bulk-renamed.
- Renamed terminals display `name` before dynamic agent title/process labels; unrenamed labels retain existing precedence.
- All production changes follow red-green-refactor: each behavior starts with a failing test.
- Existing uncommitted changes on the base checkout remain untouched; implementation happens in `tmp/worktrees/terminal-rename`.

---

### Task 1: Record and review the design

**Files:**
- Create: `docs/superpowers/specs/2026-08-07-terminal-rename-design.md`
- Create: `docs/superpowers/plans/2026-08-07-terminal-rename.md`

- [x] **Step 1: Write the design and implementation plan**

The design records the target-selection rule, persistent `customName` marker,
PATCH contract, error behavior, and test evidence required for the feature.

- [x] **Step 2: Self-review the written documents**

Check that every requirement maps to a later task, there are no placeholders,
and the backend/frontend interfaces agree on `PATCH /api/v1/terminals/{id}` and
the `{ terminal: Session }` result.

---

### Task 2: Add persistent backend rename behavior

**Files:**
- Modify: `internal/session/manager.go`
- Modify: `internal/session/sqlite_store.go`
- Test: `internal/session/manager_test.go`
- Test: `internal/session/sqlite_store_test.go`

**Interfaces:**
- Produces `Metadata.CustomName bool` and
  `(*Manager).Rename(id, name string) (Metadata, error)`.

- [ ] **Step 1: Write the failing manager tests**

Add tests that call `Rename` and assert trimmed names, the `CustomName` marker,
the persisted/reloaded metadata, and a `ChangeUpdated` callback. Add table cases
for blank and over-80-rune names that expect an error and no mutation.

- [ ] **Step 2: Run the focused tests to verify the expected failure**

Run:

```bash
go test ./internal/session -run 'TestManager.*Rename|TestSQLite.*CustomName' -count=1
```

Expected: FAIL because `Metadata.CustomName` and `Manager.Rename` do not yet
exist.

- [ ] **Step 3: Implement the minimal manager and store changes**

Trim and validate with `utf8.RuneCountInString`, lock the entry with the
existing metadata-save mutex, update `Name` and `CustomName`, save through the
ordered store operation, and emit one normal `ChangeUpdated`. Add a
`custom_name INTEGER NOT NULL DEFAULT 0` migration and include it in SQLite
load/save/upsert statements.

- [ ] **Step 4: Run the focused tests and package suite**

Run the focused command above, then:

```bash
go test ./internal/session -count=1
```

Expected: PASS with no new warnings.

- [ ] **Step 5: Commit the backend session layer**

```bash
git add internal/session/manager.go internal/session/sqlite_store.go internal/session/manager_test.go internal/session/sqlite_store_test.go
git commit -m "feat: persist renamed terminal names"
```

---

### Task 3: Expose the v1 rename endpoint

**Files:**
- Modify: `internal/control/terminal.go`
- Modify: `internal/server/v1_terminal.go`
- Modify: `internal/server/server.go`
- Modify: `internal/server/openapi.json`
- Test: `internal/server/v1_terminal_test.go`
- Test: `internal/server/v1_test.go`

**Interfaces:**
- Consumes `Manager.Rename` through the control service.
- Produces `PATCH /api/v1/terminals/{id}` with JSON `{ "name": string }` and
  a v1 result containing `terminal` metadata.

- [ ] **Step 1: Write failing route and control tests**

Add a PATCH request test for a created terminal that expects status 200, the
trimmed name, and `customName: true` in the returned terminal. Add invalid
blank/overlong requests expecting 400 `invalid_name`, a missing terminal
expecting the existing 404 error, and add the PATCH method to the schema route
method assertions.

- [ ] **Step 2: Run the focused tests to verify failure**

```bash
go test ./internal/server -run 'TestV1.*Rename|TestV1Schema' -count=1
```

Expected: FAIL because the PATCH route is not registered.

- [ ] **Step 3: Implement the endpoint and route**

Decode one JSON object, call the control rename method, map validation/not-found
errors to existing v1 error envelopes, write `{ "terminal": metadata }`,
register the PATCH route, and document the operation/request/schema in
`openapi.json`.

- [ ] **Step 4: Run server tests**

```bash
go test ./internal/server -count=1
```

Expected: PASS.

- [ ] **Step 5: Commit the endpoint**

```bash
git add internal/control/terminal.go internal/server/v1_terminal.go internal/server/server.go internal/server/openapi.json internal/server/v1_terminal_test.go internal/server/v1_test.go
git commit -m "feat: expose terminal rename API"
```

---

### Task 4: Add the frontend rename flow

**Files:**
- Modify: `web/src/api.ts`
- Modify: `web/src/types.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/components/SessionNavigation.tsx`
- Test: `web/src/api.test.ts`
- Test: `web/src/App.test.tsx`
- Test: `web/src/components/SessionNavigation.test.tsx`

**Interfaces:**
- Consumes `PATCH /api/v1/terminals/{id}` and `result.terminal`.
- Produces `ApiClient.renameTerminal(id, name): Promise<Session>` and a
  Quick Actions/dialog flow that updates the matching local session.

- [ ] **Step 1: Write failing frontend tests**

Add an API test for the PATCH path/body/envelope. Add App tests that open Quick
Actions, choose `Rename terminal…`, focus the prefilled name input, reject a
blank name without a request, keep the dialog open after a failed request, and
replace the selected sidebar label with the returned renamed session while
`syncEvents={false}`. Use an agent session with an `agentTitle` to verify
`customName` makes the renamed name win. Add a navigation test that preserves
agent-title precedence when `customName` is absent.

- [ ] **Step 2: Run focused tests to verify failure**

```bash
npm --prefix web test -- --run web/src/api.test.ts web/src/App.test.tsx web/src/components/SessionNavigation.test.tsx
```

Expected: FAIL because the API method, quick action, dialog, and custom-label
behavior do not yet exist.

- [ ] **Step 3: Implement the minimal frontend behavior**

Add the API method and optional `customName` type, derive the focused selected
target, add the action to the availability/recent catalog, and use the existing
Dialog/Input/Button primitives for the form. Trim and validate before calling
the API; on success replace the matching session and close; on error preserve
the draft and display an inline message. Make `sessionLabel` check
`customName` first.

- [ ] **Step 4: Run focused tests, then the full frontend suite**

```bash
npm --prefix web test -- --run web/src/api.test.ts web/src/App.test.tsx web/src/components/SessionNavigation.test.tsx
npm --prefix web run typecheck
npm --prefix web test -- --run
```

Expected: PASS.

- [ ] **Step 5: Run the user-visible Playwright flow when the isolated server is available**

Start the app with an isolated test database and port, open Quick Actions,
rename one terminal, and assert the sidebar label changes. Use one worker for
the state-mutating test and stop the server afterward.

- [ ] **Step 6: Commit the frontend flow**

```bash
git add web/src/api.ts web/src/types.ts web/src/App.tsx web/src/components/SessionNavigation.tsx web/src/api.test.ts web/src/App.test.tsx web/src/components/SessionNavigation.test.tsx
git commit -m "feat: rename terminals from quick actions"
```

---

### Task 5: Integrate, review, and merge

**Files:**
- Modify: only files from Tasks 2–4 if review finds issues.

- [ ] **Step 1: Review the complete diff against the design**

Check target selection, custom-name precedence, persistence, event behavior,
validation, and failure UX line by line.

- [ ] **Step 2: Run fresh verification from the integrated worktree**

```bash
go test ./...
npm --prefix web run typecheck
npm --prefix web test -- --run
npm --prefix web run build
```

- [ ] **Step 3: Request a focused code review before merge**

Provide the reviewer the base SHA, feature HEAD SHA, design file, and the exact
acceptance criteria. Fix all critical/important findings and rerun the affected
tests.

- [ ] **Step 4: Merge the verified branch into `main`**

From the base checkout, merge `codex/terminal-rename` with a non-destructive
fast-forward or regular merge as appropriate, preserving the user's existing
`web/dist/.keep` and `tmp/` changes.

