# Terminal Empty State and Running Notice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the empty terminal workspace and automatic-deselection notice with the existing `Delete terminal?` dialog design without changing behavior.

**Architecture:** Keep `App` responsible for the existing state and actions. Add only presentational wrappers/classes around the empty-state content and running notice, and use the existing `Button` component for the empty-state action so its visual treatment comes from the same design system as the delete dialog.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, CSS, Playwright.

## Global Constraints

- Preserve the existing English user-facing copy and interaction behavior.
- Keep the delete confirmation dialog and shared dialog primitives unchanged.
- Keep keyboard focus styles, responsive layout, and reduced-motion behavior intact.
- Do not touch unrelated dirty files on `main`.

---

### Task 1: Add failing App assertions for the two presentation contracts

**Files:**
- Modify: `web/src/App.test.tsx` near the existing empty-state and running-deselection tests

**Interfaces:**
- Consumes: the existing `App` test helpers, `plainTerminalSession`, and `jsonResponse` fixtures.
- Produces: regression assertions for `.empty-state-card`, `.empty-state-kicker`, `.empty-state-title`, `.empty-state-description`, `.running-deselect-toast-copy`, and `.running-deselect-toast-actions`.

- [x] **Step 1: Write the failing tests**

  Extend the existing `pane rail checkboxes remove selected terminals and allow an empty workspace` test after its second terminal is deselected and assert:

  ```ts
  expect(screen.getByText("No signal yet.")).toHaveClass("empty-state-title");
  expect(screen.getByText("Start a terminal")).toHaveClass("empty-state-action");
  expect(screen.getByText("Start a terminal")).toHaveAttribute("data-slot", "button");
  ```

  Extend the existing automatic-deselection test with:

  ```ts
  expect(screen.getByText("Terminal is now running.")).toHaveClass(
    "running-deselect-toast-title",
  );
  expect(screen.getByText("It will be removed in 10 seconds.")).toHaveClass(
    "running-deselect-toast-description",
  );
  expect(screen.getByRole("button", { name: "Cancel" })).toHaveClass(
    "running-deselect-toast-action",
  );
  ```

  Use the existing real `App` render and fetch fixtures; do not mock the new presentational elements. The app creates a terminal when the server initially returns no sessions, so the empty workspace is reached by deselecting all panes.

- [x] **Step 2: Run the focused tests and verify they fail for the missing classes/content**

  Run: `npm test -- --run src/App.test.tsx -t "empty|running"`

  Expected: FAIL because the new title/card/action classes and the empty-state title are not present yet.

### Task 2: Implement the dialog-aligned markup and styles

**Files:**
- Modify: `web/src/App.tsx:2620-2734`
- Modify: `web/src/styles.css:512-723 and the authoritative black-theme section around 1698-1749`

**Interfaces:**
- Consumes: the existing `runningDeselectNotices`, `createSession`, and `Button` behavior.
- Produces: the same actions and accessible roles with dialog-aligned presentation classes.

- [x] **Step 1: Add the minimum markup required by the failing assertions**

  Wrap the running notice copy and action in dedicated elements. Render the empty state as:

  ```tsx
  <div className="empty-state">
    <div className="empty-state-card">
      <span className="empty-state-kicker">Terminal workspace</span>
      <h2 className="empty-state-title">No signal yet.</h2>
      <p className="empty-state-description">Start a terminal to begin a session.</p>
      <Button className="empty-state-action" onClick={() => void createSession()}>
        Start a terminal
      </Button>
    </div>
  </div>
  ```

  Keep the automatic notice's `role`, accessible name, timer copy, and `Cancel` click handler unchanged.

- [x] **Step 2: Run the focused tests to verify the markup is green before styling**

  Run: `npm test -- --run src/App.test.tsx -t "empty|running"`

  Expected: PASS.

- [x] **Step 3: Add dialog-aligned CSS**

  Use the existing black-theme variables rather than introducing a second palette:

  - Center the empty state and give its card `var(--popover)`, `var(--border)`, `var(--radius-xl)`, a subtle `ring`, and compact padding.
  - Use `var(--muted-foreground)` for kicker/description and `var(--foreground)` for the title.
  - Give `.empty-state-action` the shared button sizing without reintroducing the legacy lime button rule.
  - Give the running notice the same popover surface, border, radius, and shadow as the dialog; use a bordered action footer on wide screens and stack it on narrow screens.
  - Remove the old green left-border/title/button overrides for the running notice.

- [x] **Step 4: Run the focused tests again**

  Run: `npm test -- --run src/App.test.tsx -t "empty|running"`

  Expected: PASS.

### Task 3: Verify build, regression suite, and browser presentation

**Files:**
- Modify: `web/e2e/euphony.spec.ts` only if a stable presentation assertion is needed

**Interfaces:**
- Consumes: the completed App markup and CSS.
- Produces: fresh verification evidence for the requested UI behavior and responsive layout.

- [x] **Step 1: Run the complete web build and focused App suite**

  Run: `npm run build`

  Run: `npm test -- --run src/App.test.tsx`

  Expected: both commands exit 0.

- [x] **Step 2: Run the existing E2E suite or the relevant Playwright tests**

  Run: `npm run e2e -- euphony.spec.ts`

  Expected: the existing terminal creation/deletion and running-session flows pass. The three relevant flows passed when run individually with isolated ports; a combined run had one transient shared-server timing failure, and the running-session flow passed on its own rerun.

- [x] **Step 3: Inspect the desktop and mobile screenshots**

  Use Playwright screenshots at a normal desktop viewport and a 390px mobile viewport. The desktop empty-state and running-notice screenshots show centered/card-aligned surfaces, and the mobile empty-state screenshot confirms the card remains readable without clipping.

- [x] **Step 4: Review the diff and commit the implementation**

  Run: `git diff --check`

  Run: `git status --short`

  Commit: `git add web/src/App.tsx web/src/App.test.tsx web/src/styles.css web/e2e/euphony.spec.ts && git commit -m "style: align terminal empty states with dialogs"`
