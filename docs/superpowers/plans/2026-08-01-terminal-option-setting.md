# Terminal Option-as-Alt Setting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist a Settings toggle that controls whether xterm treats macOS Option-modified keys as Alt.

**Architecture:** Add `terminalOptionAsAlt` to the existing Settings model, SQLite migration, and settings API. Thread the value through App into TerminalView, where it maps to xterm's `macOptionIsMeta` constructor option. Reuse the existing Settings draft/preview/cancel/save flow and Terminal appearance layout.

**Tech Stack:** Go, SQLite, React, TypeScript, xterm.js, Vitest, Playwright.

## Global Constraints

- Preserve the existing default behavior: `terminalOptionAsAlt` is `true`.
- Preserve existing settings on database migration by adding a column with a default of `1`.
- Keep user-facing copy in plain English and use the existing Settings visual language.
- Do not change the terminal WebSocket or PTY input protocol.

---

### Task 1: Persist and validate the terminal Option-as-Alt setting

**Files:**
- Modify: `internal/session/manager.go`
- Modify: `internal/session/sqlite_store.go`
- Modify: `internal/session/sqlite_store_test.go`
- Modify: `internal/server/settings.go`
- Modify: `internal/server/settings_test.go`

**Interfaces:**
- Produces: `session.Settings.TerminalOptionAsAlt bool`, JSON field `terminalOptionAsAlt`, and SQLite column `terminal_option_as_alt`.

- [ ] **Step 1: Add failing Go assertions for the new field**

Extend the existing settings tests so default settings assert
`TerminalOptionAsAlt == true`, the saved `want` settings include a false value,
and the API PATCH body includes `"terminalOptionAsAlt":false` and expects the
returned settings to contain false. Add an invalid API case that removes the
field from an otherwise valid request and expects HTTP 400.

- [ ] **Step 2: Run the focused Go tests and verify they fail**

Run:

```bash
go test ./internal/session ./internal/server -run 'TestSQLiteStorePersistsSettings|TestSettingsAPIReadsAndPersistsSettings|TestSettingsAPIRejectsInvalidSettings' -count=1
```

Expected: compile or assertion failures because `TerminalOptionAsAlt` and its
storage/API handling do not exist yet.

- [ ] **Step 3: Implement the minimal backend setting path**

Add `TerminalOptionAsAlt bool` to `session.Settings` and set it to true in
`DefaultSettings`. Add `terminal_option_as_alt INTEGER NOT NULL DEFAULT 1` to
the initial schema and an `ALTER TABLE` migration for existing databases.
Include the column in `LoadSettings` and `SaveSettings`, converting between
SQLite integers and Go booleans. Add the API input pointer, require it to be
non-nil, and copy it into the returned `session.Settings`.

- [ ] **Step 4: Run the focused Go tests and verify they pass**

Run the command from Step 2. Expected: PASS with no failures.

- [ ] **Step 5: Commit the backend change**

```bash
git add internal/session/manager.go internal/session/sqlite_store.go internal/session/sqlite_store_test.go internal/server/settings.go internal/server/settings_test.go
git commit -m "feat: persist terminal option as alt setting"
```

### Task 2: Thread the setting into xterm and Settings UI

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/settings.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/components/TerminalView.tsx`
- Modify: `web/src/components/TerminalView.test.tsx`
- Modify: existing TypeScript Settings fixtures that require the new field.

**Interfaces:**
- Consumes: `Settings.terminalOptionAsAlt`.
- Produces: `TerminalView` prop `optionAsAlt?: boolean` and an xterm option
  object whose `macOptionIsMeta` matches that prop.

- [ ] **Step 1: Add failing frontend tests**

Extend Settings fixtures with `terminalOptionAsAlt: true`. Add an App test that
opens Settings, unchecks `Option as Alt`, confirms the rendered terminal
receives `data-option-as-alt="false"` during preview, restores true after
Escape, then unchecks and saves and asserts the PATCH body contains
`terminalOptionAsAlt: false`. Add a TerminalView test asserting
`terminalOptions(..., false)` returns `{ macOptionIsMeta: false }`.

- [ ] **Step 2: Run the focused frontend tests and verify they fail**

Run:

```bash
npm test -- --run src/App.test.tsx src/components/TerminalView.test.tsx -t 'Option as Alt|Option input'
```

Expected: FAIL because the Settings field and xterm option plumbing do not
exist yet.

- [ ] **Step 3: Implement the setting flow and UI**

Add the setting to the TypeScript model and default constants. Thread it
through loaded settings, the draft state, preview settings, reset-on-open,
validation/save payload, and the existing terminal render callback. Add a
horizontal checkbox labeled `Option as Alt` in Terminal appearance with a
description describing macOS Option behavior. Add `optionAsAlt` to TerminalView
and its effect dependencies, pass it to `terminalOptions`, and retain a true
default for callers that do not provide the prop.

- [ ] **Step 4: Run focused tests and typecheck**

Run the command from Step 2 and:

```bash
npm run typecheck
```

Expected: PASS and exit code 0.

- [ ] **Step 5: Commit the frontend change**

```bash
git add web/src/types.ts web/src/settings.ts web/src/App.tsx web/src/App.test.tsx web/src/components/TerminalView.tsx web/src/components/TerminalView.test.tsx
git commit -m "feat: add terminal option as alt setting"
```

### Task 3: Verify the integrated behavior

**Files:**
- No additional source files.

- [ ] **Step 1: Run the complete Web unit suite**

Run: `npm test -- --run`

Expected: all test files and tests pass.

- [ ] **Step 2: Run Go settings and session tests**

Run: `go test ./internal/session ./internal/server -count=1`

Expected: settings and terminal server tests pass; report any unrelated
pre-existing failures separately rather than changing unrelated code.

- [ ] **Step 3: Build the Web application**

Run: `npm run build`

Expected: exit code 0.

- [ ] **Step 4: Run the existing Playwright suite when the server harness is available**

Run: `npm run e2e -- --workers=1`

Expected: existing browser behavior passes with an isolated test backend.

- [ ] **Step 5: Review the final diff**

Run: `git diff --check && git status --short`

Expected: no whitespace errors and only intentional changes remain.
