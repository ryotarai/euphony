# Split PTY Capacity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep PTY columns aligned with the live Terminal track while a pane source split is open or resized.

**Architecture:** `TerminalPane` remains the owner of source visibility and reports Terminal as visible whenever it occupies either grid track. `TerminalView` continues to own capacity measurement; its existing host `ResizeObserver` reports the changed column count without coupling the terminal to divider events.

**Tech Stack:** React 19, TypeScript, xterm.js with FitAddon, Vitest and Testing Library, Playwright.

## Global Constraints

- Normal navigation to a non-terminal source retains the previous terminal capacity claim.
- A visible split Terminal reports the capacity of its own grid track.
- Split interaction never focuses the terminal.
- Divider pointer and keyboard controls continue to use the existing 20% through 80% bounds.
- The existing source split layout and visual styling remain unchanged.

---

### Task 1: Report the visible split Terminal capacity

**Files:**
- Modify: `web/src/components/TerminalPane.test.tsx`
- Modify: `web/src/components/TerminalPane.tsx`
- Modify: `web/e2e/euphony.spec.ts`

**Interfaces:**
- Consumes: `sourceIsVisible(paneSource: PaneSource): boolean` and `renderTerminal(layoutVersion, active, sourceVisible)`.
- Produces: `sourceVisible=true` whenever Terminal is either the primary or secondary split source while leaving `active=false` during a split.

- [ ] **Step 1: Write the failing component test**

Change the Command-click split expectation so the render callback must receive:

```ts
expect(activeStates.at(-1)).toBe(false);
expect(sourceVisibilities.at(-1)).toBe(true);
```

Add the inverse split case: select Files normally, Command-click Terminal, and assert Terminal is visible, inactive, and reported as a visible source.

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
npm test -- --run src/components/TerminalPane.test.tsx
```

Expected: FAIL because the current split render passes `sourceVisible=false`.

- [ ] **Step 3: Implement the minimal visibility fix**

Pass the existing visibility predicate into the terminal renderer:

```tsx
renderTerminal(
  layoutVersion + fitVersion,
  active && source === "terminal" && secondarySource === null,
  sourceIsVisible("terminal"),
)
```

Do not change the `active` expression; this prevents Command-click from
stealing focus.

- [ ] **Step 4: Run focused and full component tests**

Run:

```bash
npm test -- --run src/components/TerminalPane.test.tsx
npm test -- --run
```

Expected: all tests PASS.

- [ ] **Step 5: Extend the real-browser regression**

Record the Terminal element's `data-local-cols` before the split, after opening
at 50%, after dragging to 65%, and after Command-clicking the secondary tab to
close. Assert:

```ts
expect(splitCols).toBeLessThan(fullCols);
expect(draggedCols).toBeGreaterThan(splitCols);
expect(restoredCols).toBe(fullCols);
```

Also assert the xterm screen width never exceeds the Terminal host width by
more than one pixel.

- [ ] **Step 6: Verify build and browser behavior**

Run the production build, all Go tests, and the isolated one-worker Playwright
scenario for pane source splitting. Expected: PASS with the PTY column sequence
shrinking, growing with the divider, then restoring.

- [ ] **Step 7: Commit**

```bash
git add AGENTS.md docs/superpowers/specs/2026-07-31-pane-tab-split-design.md \
  docs/superpowers/plans/2026-07-31-split-pty-capacity.md \
  web/src/components/TerminalPane.test.tsx \
  web/src/components/TerminalPane.tsx web/e2e/euphony.spec.ts
git commit -m "fix(web): resize PTY with pane source split"
```
