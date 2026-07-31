# Remove Pane Source Label Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the decorative pane-source text without changing pane source controls or split behavior.

**Architecture:** Keep `TerminalPane` state, accessibility labeling, and the source label's layout footprint intact. Make only the visible `terminal-tab-source` text transparent, and protect the behavior with the existing real-component split-view test.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, Playwright

## Global Constraints

- Preserve the 30px source rail.
- Preserve source tabs, split behavior, attention state, and pane selection.
- Keep accessible split-region names.

---

### Task 1: Remove the decorative source label

**Files:**
- Modify: `web/src/components/TerminalPane.test.tsx`
- Modify: `web/src/components/TerminalPane.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes: `TerminalPane` source selection and Command-click split behavior.
- Produces: The same interactive source rail without visible source-name text.

- [x] **Step 1: Write the failing regression assertion**

Replace the existing positive text assertion in the Command-click split test:

```tsx
expect(screen.getByText("Terminal + Workspace files")).not.toBeVisible();
```

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd web
npm test -- --run src/components/TerminalPane.test.tsx
```

Expected: FAIL because `Terminal + Workspace files` is still visible.

- [x] **Step 3: Hide the visible label while preserving its layout**

Set the existing decorative element's opacity to zero:

```tsx
<span
  className="terminal-tab-source"
  aria-hidden="true"
  style={{ opacity: 0 }}
>
  {sourceLabel(source)}
  {secondarySource && ` + ${sourceLabel(secondarySource)}`}
</span>
```

Do not remove the element or its sizing styles: its inline footprint preserves
transcript wrapping and scroll-position behavior. Do not change `sourceLabel`,
which continues to name split regions for assistive technology.

- [x] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
cd web
npm test -- --run src/components/TerminalPane.test.tsx
```

Expected: 16 tests pass.

- [x] **Step 5: Verify the complete web application**

Run:

```bash
cd web
npm test -- --run
npm run typecheck
```

Expected: all tests pass and TypeScript exits successfully.

Use Playwright to open a split source and verify that the source-name text is
absent while the tab rail and split divider remain usable.

Run the transcript scroll-position test because it guards the preserved label
footprint:

```bash
cd web
EUPHONY_E2E_PORT=18135 npx playwright test e2e/euphony.spec.ts:289 --workers=1
```

- [x] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-07-31-remove-pane-source-label-design.md \
  docs/superpowers/plans/2026-07-31-remove-pane-source-label.md \
  web/src/components/TerminalPane.test.tsx \
  web/src/components/TerminalPane.tsx \
  web/src/styles.css
git commit -m "fix(web): remove pane source label"
```
