# Configurable Terminal History Buffer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent terminal history size setting with finite MiB values and an unlimited mode, applied to server replay history and browser scrollback.

**Architecture:** Extend the shared settings contract and SQLite schema with a byte limit where zero means unlimited. Give every server session a live-updatable limit, and pass the same setting through React to an xterm.js driver whose scrollback capacity can be updated in place.

**Tech Stack:** Go, SQLite, React 19, TypeScript, xterm.js 6, Vitest, Testing Library, Playwright

## Global Constraints

- Default terminal history remains `1048576` bytes.
- `terminalHistoryLimit: 0` means unlimited.
- Finite UI values are whole MiB from 1 through 4095.
- Existing databases migrate to the 1 MiB default.
- Settings changes apply to already-running sessions.

---

### Task 1: Persist and validate the history setting

**Files:**
- Modify: `internal/session/manager.go`
- Modify: `internal/session/sqlite_store.go`
- Test: `internal/session/sqlite_store_test.go`
- Modify: `internal/server/settings.go`
- Test: `internal/server/settings_test.go`

**Interfaces:**
- Produces: `Settings.TerminalHistoryLimit int` serialized as `terminalHistoryLimit`
- Produces: `DefaultTerminalHistoryLimit = 1024 * 1024`
- Produces: API validation accepting `0` or `1048576..4293918720`

- [ ] **Step 1: Write failing persistence, migration, and API tests**

Add literal expectations showing that defaults include `1048576`, saves retain
`0` and finite limits, legacy databases migrate to `1048576`, valid PATCH
payloads round-trip the field, and missing/fractional/out-of-range values return
400.

- [ ] **Step 2: Run tests to verify RED**

Run: `go test ./internal/session ./internal/server`

Expected: FAIL because `Settings.TerminalHistoryLimit` and the database column
do not exist and PATCH rejects the new JSON field.

- [ ] **Step 3: Add the settings field, migration, load/save, and validation**

Add the field and default, migrate `settings.terminal_history_limit`, include it
in SELECT/UPDATE statements, require a numeric JSON value, and accept only zero
or whole-byte finite values in the documented range.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `go test ./internal/session ./internal/server`

Expected: PASS.

### Task 2: Apply limits to server session history

**Files:**
- Modify: `internal/session/session.go`
- Modify: `internal/session/manager.go`
- Test: `internal/session/manager_test.go`

**Interfaces:**
- Produces: `(*Session).setHistoryLimit(limit int)`
- Consumes: `Settings.TerminalHistoryLimit`

- [ ] **Step 1: Write failing history behavior tests**

Add tests that publish controlled byte chunks and assert:

```go
finite := sessionHistoryAfter(limit: 5, chunks: []string{"abc", "def"})
// finite == "bcdef"

unlimited := sessionHistoryAfter(limit: 0, chunks: []string{"abc", "def"})
// unlimited == "abcdef"
```

Add a manager test showing that `UpdateSettings` reduces an existing session's
history immediately.

- [ ] **Step 2: Run tests to verify RED**

Run: `go test ./internal/session`

Expected: FAIL because history still uses the fixed package constant.

- [ ] **Step 3: Implement per-session and live-updated limits**

Store the limit on `Session`, trim under `outputMu`, pass the manager setting
when starting sessions, and update each running session only after persistence
succeeds.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `go test ./internal/session`

Expected: PASS.

### Task 3: Configure xterm.js scrollback

**Files:**
- Modify: `web/src/components/TerminalView.tsx`
- Test: `web/src/components/TerminalView.test.tsx`

**Interfaces:**
- Produces: `terminalScrollback(historyLimit: number): number`
- Extends: `TerminalDriver.setScrollback(scrollback: number): void`
- Extends: `TerminalViewProps.terminalHistoryLimit: number`

- [ ] **Step 1: Write failing scrollback tests**

Assert that a 1 MiB limit maps to `1048576`, unlimited maps to `4294967295`,
and rerendering `TerminalView` calls `setScrollback` with the new capacity
without creating a second socket.

- [ ] **Step 2: Run tests to verify RED**

Run: `cd web && npm test -- --run src/components/TerminalView.test.tsx`

Expected: FAIL because the conversion, prop, and driver method do not exist.

- [ ] **Step 3: Implement construction and live updates**

Create xterm.js with the computed `scrollback`, expose an option setter on the
default driver, and use a focused effect to update mounted drivers when the
setting changes.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `cd web && npm test -- --run src/components/TerminalView.test.tsx`

Expected: PASS.

### Task 4: Add the Settings dialog controls

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/components/SessionNavigation.test.tsx`
- Test: `web/src/App.test.tsx`
- Test: `web/e2e/euphony.spec.ts`

**Interfaces:**
- Extends: `Settings.terminalHistoryLimit: number`
- Extends: the `renderTerminal` callback with `terminalHistoryLimit: number`
- Consumes: existing `Field`, `InputGroup`, `InputGroupInput`, `InputGroupAddon`, and `Checkbox`

- [ ] **Step 1: Write failing React tests**

Update complete Settings fixtures and add tests that assert:

```ts
expect(screen.getByLabelText("History buffer")).toHaveValue(8);
expect(screen.getByLabelText("Unlimited history")).not.toBeChecked();
```

After checking unlimited, assert the numeric input is disabled and PATCH sends
`terminalHistoryLimit: 0`. Add a separate invalid finite value test and assert
the terminal render callback receives the saved byte limit.

- [ ] **Step 2: Run tests to verify RED**

Run: `cd web && npm test -- --run src/App.test.tsx src/components/TerminalView.test.tsx`

Expected: FAIL because the settings field and controls do not exist.

- [ ] **Step 3: Implement drafts, validation, controls, and prop flow**

Convert saved bytes to a whole-MiB draft, manage the unlimited checkbox, validate
1–4095, convert back to bytes on save, and pass the setting through the
terminal render callback. Keep existing dialog styling and accessible Field
validation.

- [ ] **Step 4: Add Playwright coverage**

Extend the existing settings E2E flow to save a finite value, reopen and verify
it, then save unlimited and verify the disabled numeric control after reopening.

- [ ] **Step 5: Run tests to verify GREEN**

Run: `cd web && npm test -- --run && npm run typecheck`

Expected: all tests and type checking PASS.

### Task 5: Full verification and integration

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document the setting boundary**

Update the settings or terminal reliability documentation to state that terminal
history is memory-resident, configurable, and not persisted across server
restarts.

- [ ] **Step 2: Run all automated checks**

Run: `make test`

Expected: Go tests, Vitest, and TypeScript checks PASS.

- [ ] **Step 3: Run focused Playwright verification**

Run: `cd web && npx playwright test e2e/euphony.spec.ts --grep "persists sidebar controls, settings"`

Expected: PASS using the isolated E2E database from project scripts/config.

- [ ] **Step 4: Review the diff and commit**

Run: `git diff --check && git status --short`

Then stage only the task files and commit with:

```text
feat: configure terminal history buffer
```
