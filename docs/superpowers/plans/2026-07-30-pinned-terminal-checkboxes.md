# Pinned Terminal Checkboxes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Shift-click pinning to terminal checkboxes so pinned panes survive all indirect workspace selection changes.

**Architecture:** `App` owns pinned session IDs and includes them in URL workspace serialization. `SessionNavigation` reports checkbox Shift state and renders a compact pinned marker; all selection-replacement paths merge pinned IDs while direct checkbox removal clears both states.

**Tech Stack:** React 19, TypeScript, Base UI checkbox, Lucide icons, Vitest, Testing Library, Playwright.

## Global Constraints

- Preserve all existing non-pinned selection and dynamic-filter behavior.
- Keep `pinnedIDs` limited to available selected sessions.
- Persist pins with repeated `pin` URL parameters.
- Use the existing sidebar layout and only one amber pinned-state accent.

---

### Task 1: Checkbox pin interaction

**Files:**
- Modify: `web/src/components/SessionNavigation.tsx`
- Modify: `web/src/styles.css`
- Test: `web/src/components/SessionNavigation.test.tsx`

**Interfaces:**
- Consumes: `selectedIDs: string[]` and new `pinnedIDs?: string[]`.
- Produces: `onSelect(id: string, multiple: boolean, pin?: boolean)` where
  `pin` is true only for Shift-click checkbox interactions.

- [ ] **Step 1: Write the failing component test**

Add a test that Shift-clicks `Include Terminal in split`, expects
`onSelect("three", true, true)`, rerenders with `pinnedIDs={["three"]}`, and
asserts the checkbox wrapper exposes pinned state and removal guidance.

- [ ] **Step 2: Run the component test to verify RED**

Run: `npm test -- --run src/components/SessionNavigation.test.tsx`

Expected: FAIL because `pinnedIDs` and the third `onSelect` argument do not
exist.

- [ ] **Step 3: Implement the navigation interaction and marker**

Read `event.shiftKey` from the terminal checkbox click, forward it through
`onSelect`, render `PinIcon` for pinned sessions, and add focused amber styles
under `.pane-checkbox-pin[data-pinned="true"]`.

- [ ] **Step 4: Run the component test to verify GREEN**

Run: `npm test -- --run src/components/SessionNavigation.test.tsx`

Expected: PASS.

### Task 2: Pinned workspace state

**Files:**
- Modify: `web/src/App.tsx`
- Test: `web/src/App.test.tsx`

**Interfaces:**
- Consumes: `onSelect(id, multiple, pin)` from Task 1.
- Produces: URL workspace state `{ selectedIDs, pinnedIDs, focusedID,
  statusFilters, cwdFilters }` using repeated `pin` parameters.

- [ ] **Step 1: Write failing App behavior tests**

Add tests that:

1. Shift-click a terminal checkbox, row-select another terminal, and expect
   both panes plus `pin=session-1` in the URL.
2. Click the pinned checkbox and expect that pane and its `pin` parameter to be
   removed.
3. Load `?terminal=session-2&pin=session-1` and expect both panes restored.

- [ ] **Step 2: Run the App tests to verify RED**

Run: `npm test -- --run src/App.test.tsx`

Expected: FAIL because the app neither owns nor serializes pin state.

- [ ] **Step 3: Implement minimal pin state and preservation**

Add `pinnedIDs`, parse/write `pin` parameters, merge pins into all indirect
workspace replacements, exempt pins from dynamic-filter ownership, remove
deleted/unavailable pins, and make a direct pinned-checkbox click deselect even
the final pane.

- [ ] **Step 4: Run App tests to verify GREEN**

Run: `npm test -- --run src/App.test.tsx`

Expected: PASS.

### Task 3: Browser behavior and complete verification

**Files:**
- Test: `web/e2e/euphony.spec.ts`

**Interfaces:**
- Consumes: the rendered sidebar checkbox and URL workspace state from Tasks 1
  and 2.
- Produces: an end-to-end regression test for the complete pin workflow.

- [ ] **Step 1: Write the failing Playwright test**

Create two terminals, Shift-click the first terminal checkbox, row-select the
second terminal, assert both panes remain and `pin` names the first session,
then click the pinned checkbox and assert only the second pane remains.

- [ ] **Step 2: Run the focused Playwright test**

Run: `npm run e2e -- --grep "pins a terminal checkbox"`

Expected after implementation: PASS.

- [ ] **Step 3: Run all verification**

Run: `npm test -- --run`

Run: `npm run typecheck`

Run: `npm run build`

Run: `npm run e2e -- --workers=1`

Expected: all commands exit 0 with no test failures.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers web/src web/e2e/euphony.spec.ts
git commit -m "feat: pin terminal checkbox selections"
```
