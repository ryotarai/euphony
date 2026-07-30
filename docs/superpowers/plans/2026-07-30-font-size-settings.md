# Font Size Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent, independently configurable interface, terminal, and agent-log font sizes.

**Architecture:** Extend the existing server-owned `Settings` record and SQLite
row with three validated integers. Keep saved and draft settings separate in
React, pass terminal size into xterm construction, and expose interface and
agent-log sizes through scoped CSS custom properties.

**Tech Stack:** Go, SQLite, React 19, TypeScript, xterm.js, Tailwind/shadcn,
Vitest/Testing Library, Playwright

## Global Constraints

- Defaults are Interface 16 px, Terminal 14 px, and Agent log 14 px.
- Every font size must be an integer from 10 through 24 inclusive.
- Changes preview while Settings is open and revert when it closes without a successful save.
- Existing databases migrate without changing their visible font sizes.
- The existing dense black terminal-workspace visual direction remains intact.

---

### Task 1: Persist and validate font sizes

**Files:**
- Modify: `internal/session/manager.go`
- Modify: `internal/session/sqlite_store.go`
- Test: `internal/session/sqlite_store_test.go`
- Modify: `internal/server/settings.go`
- Test: `internal/server/settings_test.go`

**Interfaces:**
- Produces: `session.Settings.InterfaceFontSize int`
- Produces: `session.Settings.TerminalFontSize int`
- Produces: `session.Settings.AgentLogFontSize int`
- Produces: JSON fields `interfaceFontSize`, `terminalFontSize`, and `agentLogFontSize`

- [ ] **Step 1: Write failing persistence and migration tests**

Extend the default and round-trip assertions with literal values `16`, `14`,
and `14`. Create a legacy settings table without the new columns, open it with
`OpenSQLiteStore`, and assert the three defaults are loaded.

- [ ] **Step 2: Run the persistence tests and verify RED**

Run: `go test ./internal/session -run 'Settings'`

Expected: compilation fails because the three `Settings` fields do not exist.

- [ ] **Step 3: Implement the settings fields and SQLite migration**

Add the three fields to `Settings` and `DefaultSettings`. Add three
`INTEGER NOT NULL DEFAULT ...` columns to new schemas, use `hasColumn` plus
`ALTER TABLE` for legacy schemas, then include all three columns in
`LoadSettings` and `SaveSettings`.

- [ ] **Step 4: Run persistence tests and verify GREEN**

Run: `go test ./internal/session -run 'Settings'`

Expected: PASS.

- [ ] **Step 5: Write failing API tests**

Extend the successful PATCH payload and response assertion with
`interfaceFontSize: 18`, `terminalFontSize: 16`, and `agentLogFontSize: 15`.
Add table cases for `9`, `25`, and `14.5` in each field.

- [ ] **Step 6: Run API tests and verify RED**

Run: `go test ./internal/server -run 'SettingsAPI'`

Expected: successful payload is rejected because the handler disallows the new
fields.

- [ ] **Step 7: Implement API decoding and validation**

Decode the three fields as `float64`; reject NaN, infinity, fractions, and
values outside 10–24. Convert validated values to integers when constructing
`session.Settings`.

- [ ] **Step 8: Run server and session tests**

Run: `go test ./internal/session ./internal/server`

Expected: PASS.

- [ ] **Step 9: Commit the backend**

```bash
git add internal/session/manager.go internal/session/sqlite_store.go internal/session/sqlite_store_test.go internal/server/settings.go internal/server/settings_test.go
git commit -m "feat: persist font size settings"
```

### Task 2: Apply terminal and agent-log sizes

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/components/TerminalView.tsx`
- Test: `web/src/components/TerminalView.test.tsx`
- Modify: `web/src/components/AgentLogView.tsx`
- Test: `web/src/components/AgentLogView.test.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes: `Settings.terminalFontSize`, `Settings.agentLogFontSize`
- Produces: `TerminalViewProps.fontSize: number`
- Produces: `AgentLogViewProps.fontSize: number`
- Produces: `createTerminal(fontSize: number): TerminalDriver`

- [ ] **Step 1: Write failing component tests**

For TerminalView, inject `createTerminal(fontSize)` and assert the received
literal is `18`; rerender with `20` and assert a second driver is created. For
AgentLogView, render with `fontSize={17}` and assert its region has
`--agent-log-font-size: 17px`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm test -- --run src/components/TerminalView.test.tsx src/components/AgentLogView.test.tsx`

Expected: TypeScript reports that the new props and factory parameter do not exist.

- [ ] **Step 3: Implement font-size props**

Add the settings fields to the TypeScript interface. Pass `fontSize` to
`new Terminal({ fontSize })`, include it in TerminalView's creation effect
dependencies so a change recreates and refits xterm, and set
`--agent-log-font-size` on the agent-log region.

- [ ] **Step 4: Scale agent-log typography**

Use `--agent-log-font-size` as the transcript body base and derive metadata,
headings, code, and table sizes with `calc()` while preserving current ratios
at 14 px.

- [ ] **Step 5: Run focused and full component tests**

Run: `npm test -- --run src/components/TerminalView.test.tsx src/components/AgentLogView.test.tsx`

Run: `npm test -- --run`

Expected: PASS.

- [ ] **Step 6: Commit component behavior**

```bash
git add web/src/types.ts web/src/components/TerminalView.tsx web/src/components/TerminalView.test.tsx web/src/components/AgentLogView.tsx web/src/components/AgentLogView.test.tsx web/src/styles.css
git commit -m "feat: apply terminal and agent log font sizes"
```

### Task 3: Add the font-size settings UI

**Files:**
- Modify: `web/src/App.tsx`
- Test: `web/src/App.test.tsx`
- Modify: `web/src/components/TerminalPane.tsx`
- Test: `web/src/components/TerminalPane.test.tsx`
- Modify: `web/src/components/SessionNavigation.test.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes: all three new `Settings` fields
- Produces: three labeled number inputs with names matching the JSON settings
- Produces: scoped CSS variable `--interface-font-size`

- [ ] **Step 1: Update settings fixtures and write failing App tests**

Add the three default fields to every `Settings` fixture. Open Settings, change
the three labeled inputs, and assert the workspace preview variables/terminal
props update before saving. Assert Save sends the three integer values. Add a
second test that dismisses the dialog and asserts the saved values return.

- [ ] **Step 2: Run App tests and verify RED**

Run: `npm test -- --run src/App.test.tsx`

Expected: the three labeled controls cannot be found.

- [ ] **Step 3: Implement separate drafts and validation**

Store the three input drafts as strings, reset them from saved settings in
`openSettings`, parse them with `Number`, and accept only integers from 10–24.
When open, derive preview settings from valid drafts; otherwise use saved
settings.

- [ ] **Step 4: Render and route preview settings**

Render Interface, Terminal, and Agent log numeric inputs with `min={10}`,
`max={24}`, `step={1}`, and `inputMode="numeric"`. Put
`--interface-font-size` on `.workspace`, pass terminal size through
`TerminalPane` to `TerminalView`, and pass agent-log size to `AgentLogView`.

- [ ] **Step 5: Style the compact responsive control group**

Add a three-column `.font-size-fields` layout and a narrow-screen breakpoint
that stacks it. Scale the workspace root from the configured interface base
without changing the terminal canvas size.

- [ ] **Step 6: Run frontend tests and build**

Run: `npm test -- --run`

Run: `npm run build`

Expected: PASS.

- [ ] **Step 7: Commit the UI**

```bash
git add web/src/App.tsx web/src/App.test.tsx web/src/components/TerminalPane.tsx web/src/components/TerminalPane.test.tsx web/src/components/SessionNavigation.test.tsx web/src/styles.css
git commit -m "feat: add font size controls"
```

### Task 4: Verify the complete behavior

**Files:**
- Modify: `web/e2e/euphony.spec.ts`

**Interfaces:**
- Consumes: `/api/settings`, Settings dialog labels, and applied CSS variables
- Produces: regression coverage across save and reload

- [ ] **Step 1: Write the failing E2E assertion**

In the settings persistence test, fill Interface with `18`, Terminal with `17`,
and Agent log with `16`; save, reload, reopen Settings, and assert all three
values remain. Assert the workspace and agent-log CSS variables and xterm
rendered font size reflect the saved values.

- [ ] **Step 2: Run the focused E2E test**

Run: `npm run e2e -- --grep "persists sidebar controls, settings"`

Expected before the UI implementation: FAIL because the controls are missing.
After Tasks 1–3: PASS.

- [ ] **Step 3: Run complete verification**

Run: `go test ./...`

Run: `npm test -- --run`

Run: `npm run build`

Run: `npm run e2e -- --workers=1`

Expected: all commands PASS.

- [ ] **Step 4: Inspect desktop and mobile screenshots**

Confirm the Settings dialog has no clipping at 1440×900 and 390×844, labels
remain associated with their inputs, and the font-size row stacks on mobile.

- [ ] **Step 5: Commit E2E coverage**

```bash
git add web/e2e/euphony.spec.ts
git commit -m "test: cover font size settings"
```

