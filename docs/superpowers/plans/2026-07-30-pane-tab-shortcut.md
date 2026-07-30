# Pane Tab Shortcut and Markdown Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a configurable focused-pane tab toggle shortcut and readable borders and spacing to agent-log Markdown tables.

**Architecture:** Persist `paneTabShortcut` beside the existing workspace settings, pass it to each `TerminalPane`, and let only the active pane handle the matching global key event. Keep table presentation in the existing agent-log Markdown stylesheet and verify the visual contract in Playwright.

**Tech Stack:** Go, SQLite, React 19, TypeScript, Base UI/shadcn, Vitest, Playwright.

## Global Constraints

- Default shortcut is exactly `Meta+L`.
- Shortcut values use the existing modifier-plus-key syntax.
- Only the focused pane toggles.
- Form controls suppress the pane shortcut; xterm remains eligible.
- Existing click tab switching and terminal mounting behavior must remain intact.
- Markdown tables retain the existing neutral dark visual language.

---

### Task 1: Persist the pane tab shortcut

**Files:**
- Modify: `internal/session/manager.go`
- Modify: `internal/session/sqlite_store.go`
- Modify: `internal/session/sqlite_store_test.go`
- Modify: `internal/server/settings.go`
- Modify: `internal/server/settings_test.go`

**Interfaces:**
- Produces: `session.Settings.PaneTabShortcut string` serialized as `paneTabShortcut`.
- Produces: SQLite `settings.pane_tab_shortcut`.

- [ ] **Step 1: Write failing persistence and API tests**

Extend Settings expectations so defaults include `Meta+L`, updates save
`Ctrl+J`, legacy settings tables migrate to `Meta+L`, and invalid or missing
`paneTabShortcut` values return HTTP 400.

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
go test ./internal/session ./internal/server -run 'TestSQLiteStore.*Settings|TestSettingsAPI'
```

Expected: compilation or assertion failures because `PaneTabShortcut` and its
database column do not exist.

- [ ] **Step 3: Implement the additive settings migration**

Add the field and default, create/migrate `pane_tab_shortcut`, include it in
settings SELECT/UPDATE statements, validate it in the PATCH handler, and return
it in API responses.

- [ ] **Step 4: Run the focused tests**

Run the command from Step 2. Expected: PASS.

### Task 2: Expose and use the configurable shortcut

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/keybindings.ts`
- Modify: `web/src/keybindings.test.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/components/SessionNavigation.test.tsx`
- Modify: `web/src/components/TerminalPane.tsx`
- Modify: `web/src/components/TerminalPane.test.tsx`
- Add through shadcn CLI: `web/src/components/ui/field.tsx`

**Interfaces:**
- Consumes: `Settings.paneTabShortcut`.
- Produces: `TerminalPane.tabShortcut: string`.

- [ ] **Step 1: Write failing component and Settings tests**

Add tests showing an active pane toggles on `Meta+L`, a custom `Ctrl+J` replaces
the default, inactive panes and ordinary inputs ignore the shortcut, and the
Settings PATCH body includes the normalized custom shortcut.

- [ ] **Step 2: Verify the new tests fail**

Run:

```bash
npm test -- --run src/components/TerminalPane.test.tsx src/App.test.tsx src/keybindings.test.ts
```

Expected: type or assertion failures because the setting, prop, and handler are
missing.

- [ ] **Step 3: Add the shadcn Field primitive**

Run:

```bash
npx shadcn@latest add field
```

Review the generated Base UI component and its imports.

- [ ] **Step 4: Implement the shortcut and form**

Add the Settings field/default/draft validation, pass the configured shortcut
to `TerminalPane`, register an active-pane keydown handler using
`matchesPrefix` and `isEditableTarget`, and compose Settings with
`FieldGroup`, `Field`, `FieldLabel`, `FieldDescription`, and `FieldError`.

- [ ] **Step 5: Run focused Web tests**

Run the command from Step 2. Expected: PASS.

### Task 3: Style and verify Markdown tables

**Files:**
- Modify: `web/src/components/AgentLogView.test.tsx`
- Modify: `web/src/styles.css`
- Modify: `web/e2e/euphony.spec.ts`
- Modify: `web/e2e/terminal-reliability.spec.ts`

**Interfaces:**
- Consumes: standard table HTML emitted by `react-markdown`.
- Produces: bordered, padded table cells within `.agent-log-markdown`.

- [ ] **Step 1: Add failing Playwright table and shortcut assertions**

Include a Markdown table in the transcript fixture, assert semantic table
content, `1px` cell borders, and non-zero cell padding. Add default and custom
shortcut flows. Include `paneTabShortcut` in every E2E Settings reset payload.

- [ ] **Step 2: Run the targeted Playwright test**

Run:

```bash
npx playwright test e2e/euphony.spec.ts -g 'live agent transcript'
```

Expected: FAIL on the computed border or padding assertion.

- [ ] **Step 3: Add the table styles**

Add scoped `table`, `th`, and `td` rules under `.agent-log-markdown` with
collapsed borders, `0.5rem 0.65rem` padding, left alignment, and the existing
neutral palette.

- [ ] **Step 4: Re-run targeted tests**

Run the command from Step 2. Expected: PASS.

### Task 4: Full verification and integration

**Files:**
- Verify all modified files.

- [ ] **Step 1: Run formatting and static checks**

```bash
gofmt -w internal/session/manager.go internal/session/sqlite_store.go internal/session/sqlite_store_test.go internal/server/settings.go internal/server/settings_test.go
git diff --check
npm run typecheck
npm run build
```

- [ ] **Step 2: Run complete automated tests**

```bash
go test ./...
npm test -- --run
npm run e2e
```

Expected: all checks pass.

- [ ] **Step 3: Review the rendered UI**

Inspect the Playwright screenshot for shortcut Settings spacing and table
readability at desktop width.

- [ ] **Step 4: Commit and merge**

Commit the implementation in the task worktree and merge the verified branch
into `main`, preserving unrelated base-checkout changes.

