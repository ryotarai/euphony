# Pane Selection Checkbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a checked control to each pane source rail that removes that terminal from the workspace selection when unchecked.

**Architecture:** `TerminalPane` renders the pane-local checkbox and emits a narrow `onDeselect()` callback. `App` owns the selection mutation, URL synchronization, focus fallback, and filter decomposition by extending the existing `selectSession` path with an explicit final-pane removal option.

**Tech Stack:** React 19, TypeScript, shadcn Checkbox, Vitest, Testing Library, Playwright

## Global Constraints

- Keep the existing 30px rail height and monochrome terminal workspace palette.
- The checkbox accessible name is `Deselect <terminal name>`.
- Only the pane checkbox may remove the final selected pane; sidebar behavior remains unchanged.
- Dynamic status and cwd filters must not immediately re-add a deselected pane.
- Do not add dependencies.

---

### Task 1: Pane-local deselection control

**Files:**
- Modify: `web/src/components/TerminalPane.tsx`
- Modify: `web/src/components/TerminalPane.test.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/styles.css`
- Modify: `web/e2e/euphony.spec.ts`

**Interfaces:**
- Consumes: `Checkbox` from `@/components/ui/checkbox` and the existing `App.selectSession(id, multiple)` selection path.
- Produces: `TerminalPaneProps.onDeselect: () => void` and `selectSession(id: string, multiple: boolean, allowEmpty?: boolean): void`.

- [ ] **Step 1: Write failing component and application tests**

Add a `TerminalPane` assertion that the checked checkbox named
`Deselect Terminal one` calls `onDeselect` after the user unchecks it:

```tsx
const onDeselect = vi.fn();
render(<TerminalPane {...requiredProps} onDeselect={onDeselect} />);
await user.click(screen.getByRole("checkbox", { name: "Deselect Terminal one" }));
expect(onDeselect).toHaveBeenCalledOnce();
```

Add an `App` test that selects two terminals, unchecks the first pane control,
and expects only the second pane and `terminal=session-2` in the URL. Then
uncheck the remaining pane and expect the existing `No signal yet.` state with
no `terminal` or `focus` parameters.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
cd web
npm test -- --run src/components/TerminalPane.test.tsx src/App.test.tsx
```

Expected: FAIL because `TerminalPane` has no `onDeselect` prop or checkbox.

- [ ] **Step 3: Add the minimal control and selection callback**

Add the callback to `TerminalPaneProps`, render the existing shadcn `Checkbox`
in `.terminal-tab-selection`, and invoke `onDeselect` only when its checked
state becomes false. Stop pointer propagation so the parent pane does not
receive a focus gesture first.

Extend the selection function:

```ts
function selectSession(id: string, multiple: boolean, allowEmpty = false) {
  // Existing filter decomposition remains unchanged.
  // Preserve the selected item only when it is the final item and
  // allowEmpty is false.
}
```

Pass `onDeselect={() => selectSession(pane.id, true, true)}` from `App`.

- [ ] **Step 4: Style the checkbox inside the existing rail**

Keep the checkbox 14px square and group it with `.terminal-tab-source` at the
rail's right edge. Do not alter rail height, pane padding, border radius, or
source-tab sizing.

- [ ] **Step 5: Run focused and full unit checks**

Run:

```bash
cd web
npm test -- --run src/components/TerminalPane.test.tsx src/App.test.tsx
npm test -- --run
npm run typecheck
```

Expected: all tests pass and TypeScript reports no errors.

- [ ] **Step 6: Add and run the browser behavior test**

Extend the existing split-pane Playwright flow to locate
`Deselect Codex`, uncheck it, and assert the Codex pane disappears while the
other selected pane remains. Use the isolated test server already configured by
the suite.

Run:

```bash
cd web
npm run e2e -- --grep "deselects a terminal from its pane rail"
```

Expected: PASS in Chromium.

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/specs/2026-07-30-pane-selection-checkbox-design.md \
  docs/superpowers/plans/2026-07-30-pane-selection-checkbox.md \
  web/src/components/TerminalPane.tsx \
  web/src/components/TerminalPane.test.tsx \
  web/src/App.tsx \
  web/src/App.test.tsx \
  web/src/styles.css \
  web/e2e/euphony.spec.ts
git commit -m "feat: add pane selection checkbox"
```
