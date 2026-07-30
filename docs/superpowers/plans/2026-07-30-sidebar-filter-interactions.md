# Sidebar Filter Interactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make sidebar hierarchy and inherited filters predictable, and align Settings with the shadcn dialog system.

**Architecture:** Keep filter ownership in `App`, where session data is available for decomposing a status filter into cwd filters. Keep `SessionNavigation` presentational: it derives checked and indeterminate states from controlled props and emits explicit status, cwd, and terminal actions.

**Tech Stack:** React 19, TypeScript, shadcn/ui Base UI, Vitest, Testing Library, Playwright

## Global Constraints

- Preserve the black workspace and flush terminal panes.
- Preserve dynamic filter behavior as sessions change.
- Use the existing shadcn Sidebar, Dialog, Input, Button, and Checkbox primitives.
- Keep status, cwd, terminal, and focus state shareable through the URL.

---

### Task 1: Sidebar Hierarchy and Controlled Actions

**Files:**
- Modify: `web/src/components/SessionNavigation.test.tsx`
- Modify: `web/src/components/SessionNavigation.tsx`
- Modify: `web/src/components/ui/checkbox.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes: `statusFilters`, `cwdFilters`, `selectedIDs`
- Produces: `onCwdSelect(status, cwd)` and inherited checkbox state

- [ ] **Step 1: Write failing component tests**

Assert that cwd labels are buttons, status selection checks descendant cwd
controls, partial cwd selection marks status as mixed, and terminal rows have a
dedicated nested menu class.

- [ ] **Step 2: Run the component test**

Run: `npm test -- --run src/components/SessionNavigation.test.tsx`

Expected: FAIL because cwd labels are static headings, inherited state is not
derived, and terminal menus have no nested class.

- [ ] **Step 3: Implement the controlled presentation**

Add `onCwdSelect(status: string, cwd: string)`, derive `checked` and
`indeterminate` from the controlled filters, and nest terminal menus with a
structural class. Render a minus icon for mixed shadcn Checkbox state.

- [ ] **Step 4: Run the component test**

Run: `npm test -- --run src/components/SessionNavigation.test.tsx`

Expected: PASS.

### Task 2: Hierarchical Filter State

**Files:**
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/App.tsx`

**Interfaces:**
- Consumes: sidebar callbacks and the current session list
- Produces: URL-backed status and cwd filters with inherited deselection

- [ ] **Step 1: Write failing App tests**

Cover status-to-cwd propagation, cwd exclusion under an active status, cwd-label
exclusive selection, and terminal deselection that clears matching ancestor
filters without dropping unrelated panes.

- [ ] **Step 2: Run the App test**

Run: `npm test -- --run src/App.test.tsx`

Expected: FAIL because current terminal toggles leave ancestor filters active
and cwd labels have no selection callback.

- [ ] **Step 3: Implement filter decomposition**

When a cwd is unchecked under a status filter, replace the status with cwd
filters for its siblings. When a terminal is unchecked, remove matching
ancestor filters, preserve the other selected IDs, and retain filters for
unaffected cwd groups. Consolidate all selected cwd children into their status.

- [ ] **Step 4: Run the App test**

Run: `npm test -- --run src/App.test.tsx`

Expected: PASS.

### Task 3: Settings Dialog

**Files:**
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes: existing `settingsOpen`, `prefixDraft`, and `saveSettings`
- Produces: controlled shadcn Settings dialog

- [ ] **Step 1: Write a failing Settings test**

Assert that Settings renders a shadcn dialog and input, owns initial focus,
closes with Escape, and still persists a changed prefix.

- [ ] **Step 2: Run the Settings test**

Run: `npm test -- --run src/App.test.tsx -t settings`

Expected: FAIL because Settings uses a custom overlay and raw input/buttons.

- [ ] **Step 3: Compose the shadcn dialog**

Use `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`,
`DialogDescription`, `Input`, `DialogFooter`, and `Button`. Keep form errors and
the command hint inside the dialog.

- [ ] **Step 4: Run the Settings test**

Run: `npm test -- --run src/App.test.tsx -t settings`

Expected: PASS.

### Task 4: Browser Verification and Integration

**Files:**
- Modify: `web/e2e/euphony.spec.ts`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: completed sidebar and Settings behavior
- Produces: browser regression coverage and a reusable hierarchy rule

- [ ] **Step 1: Add Playwright coverage**

Assert that terminal checkboxes are indented beyond cwd checkboxes, cwd labels
replace the pane selection, inherited cwd checks appear under a status, and a
terminal can be removed without being re-added.

- [ ] **Step 2: Run full verification**

Run: `npm test -- --run`

Run: `npm run typecheck`

Run: `npm run build`

Run: `npm run e2e`

Run: `go test ./...`

Expected: every command exits zero.

- [ ] **Step 3: Review, commit, and merge**

Review the diff, commit the worktree branch, merge it into `main`, re-run the
unit suites on `main`, and remove the integrated worktree and branch.
