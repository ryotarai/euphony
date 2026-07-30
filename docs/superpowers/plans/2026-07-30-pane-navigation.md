# Pane Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep terminal panes at least 360px wide and add one-pane-at-a-time left/right navigation when selected panes overflow.

**Architecture:** A focused `PaneCarousel` measures the terminal viewport with `ResizeObserver`, derives an integer visible capacity, and translates an equal-track CSS rail without unmounting terminal content. `App` provides pane content and retains ownership of selection, focus, URL, and connection behavior.

**Tech Stack:** React 19, TypeScript, CSS Grid, ResizeObserver, Lucide icons, Vitest, Testing Library, Playwright.

## Global Constraints

- Work only in `tmp/worktrees/pane-navigation` until the verified branch is merged.
- Keep every selected terminal and its pane-local tab state mounted while off-screen.
- Use a `360px` pane minimum and show only whole panes.
- Move exactly one pane per arrow press.
- Reveal a pane when existing selection or keyboard focus moves to it.
- Preserve the existing one-worker, in-memory-database end-to-end setup.

---

### Task 1: Add the measured pane carousel

**Files:**
- Create: `web/src/components/PaneCarousel.tsx`
- Create: `web/src/components/PaneCarousel.test.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- Produces: `visiblePaneCount(width: number, paneCount: number): number`.
- Produces: `PaneCarousel({ panes, focusedID, onFocus })`.
- Each `panes` item contains `id`, `label`, and mounted React `content`.

- [ ] **Step 1: Write failing capacity and interaction tests**

```tsx
expect(visiblePaneCount(719, 3)).toBe(1);
expect(visiblePaneCount(720, 3)).toBe(2);

render(
  <PaneCarousel
    panes={[
      { id: "one", label: "One pane", content: <div>one</div> },
      { id: "two", label: "Two pane", content: <div>two</div> },
      { id: "three", label: "Three pane", content: <div>three</div> },
    ]}
    focusedID="one"
    onFocus={vi.fn()}
  />,
);
```

Trigger a `720px` observer entry. Assert panes one and two are marked visible,
only the next button exists, one click marks panes two and three visible, and
only the previous button remains.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
npm test -- --run src/components/PaneCarousel.test.tsx
```

Expected: FAIL because `PaneCarousel` does not exist.

- [ ] **Step 3: Implement the minimum carousel behavior**

Add the width observer, visible-count calculation, clamped offset, focus reveal,
edge buttons, mounted pane rail, and `data-visible` markers. Style equal grid
tracks, clipping, edge controls, focus rings, and reduced motion using the
existing black workspace tokens.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
npm test -- --run src/components/PaneCarousel.test.tsx
```

Expected: PASS.

### Task 2: Integrate the carousel and verify browser behavior

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/e2e/euphony.spec.ts`

**Interfaces:**
- Consumes: `PaneCarousel` from Task 1.
- Preserves: `focusPane(id)`, `renderTerminal(...)`, and terminal
  `layoutVersion`.

- [ ] **Step 1: Write a failing Playwright overflow test**

Create four selected terminals in a `1000px` viewport. Assert the visible
terminal panes are each at least `360px`, the next control is present, one
press hides the first pane and reveals the next pane, and the previous control
appears.

- [ ] **Step 2: Integrate `PaneCarousel` in `App`**

Replace the dynamic `terminal-stage` grid columns with carousel items. Keep
request and connection messages as stage overlays, pass pane clicks to
`focusPane`, and keep `TerminalPane` content unchanged.

- [ ] **Step 3: Run unit, type, and browser verification**

Run:

```bash
npm test -- --run
npm run typecheck
npm run e2e -- --grep "navigates overflowing terminal panes"
```

Expected: all commands PASS with no warnings.

- [ ] **Step 4: Run the full project verification**

Run:

```bash
go test ./...
make build
cd web && npm run e2e
```

Expected: Go, web build, and the complete Chromium suite PASS.

