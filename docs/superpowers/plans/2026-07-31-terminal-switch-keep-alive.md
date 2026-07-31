# Terminal Switch Keep-Alive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve mounted browser terminal views across terminal selection changes so returning to a terminal does not visibly replay its history.

**Architecture:** Track terminal IDs selected during the current browser session. Extend `PaneCarousel` to render selected panes and cached panes in one keyed tree, while calculating layout only from selected panes. Mark cached pane roots `hidden` so xterm remains mounted but does not participate in layout or PTY size negotiation.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, existing xterm/WebSocket lifecycle.

## Global Constraints

- Keep terminal processes and existing server history behavior unchanged.
- Do not change the terminal WebSocket message schema.
- Keep selected pane order, focus behavior, carousel controls, and existing tab interactions unchanged.
- Remove cached panes when their sessions disappear from the server session list.
- Follow the project's existing frontend test and typecheck commands.

---

### Task 1: Make cached panes part of the stable carousel tree

**Files:**
- Modify: `web/src/components/PaneCarousel.tsx`
- Test: `web/src/components/PaneCarousel.test.tsx`

**Interfaces:**
- Extend `PaneCarouselItem` with an optional `cached` flag.
- Consume `panes` containing selected items followed by cached items.
- Preserve `data-visible` and carousel navigation for selected items only.

- [x] **Step 1: Write the failing cached-pane test**

Add a test that renders one selected pane and one `{ cached: true }` pane,
reports a viewport width, and asserts the cached pane is hidden, does not
increase the visible count, and remains in the DOM.

- [x] **Step 2: Run the focused test to verify RED**

Run: `cd web && npm test -- --run src/components/PaneCarousel.test.tsx`

Expected: FAIL because cached panes are currently treated as regular visible
carousel panes and no cached flag is supported.

- [x] **Step 3: Implement selected-only layout with stable cached children**

Derive `displayedPanes` by filtering `cached !== true`. Use that list for
visible count, focus index, pane key, and offset calculations. Render all items
under the existing track; set `hidden={pane.cached}` for cached items and keep
their keyed content mounted. Keep offscreen selected panes visible to layout as
before, using their existing `data-visible` and `aria-hidden` attributes.

- [x] **Step 4: Run the focused carousel tests**

Run: `cd web && npm test -- --run src/components/PaneCarousel.test.tsx`

Expected: all carousel tests pass.

### Task 2: Retain selected terminal views in App

**Files:**
- Modify: `web/src/App.tsx`
- Test: `web/src/App.test.tsx`

**Interfaces:**
- Track selected terminal IDs that remain available in `sessions` with a
  session-scoped ref.
- Pass selected and cached terminal items to `PaneCarousel` with the same
  `TerminalPane` keys.

- [x] **Step 1: Write the failing terminal lifetime test**

Add a small probe component with mount and unmount counters. Render the App
with two sessions, select the first terminal, switch to the second, switch
back, and assert the first probe mounted once and never unmounted during the
switch. Also assert the cached first pane remains hidden while the second is
selected.

- [x] **Step 2: Run the focused test to verify RED**

Run: `cd web && npm test -- --run src/App.test.tsx -t "keeps terminal views alive"`

Expected: FAIL because `App` currently passes only selected sessions to
`PaneCarousel`, so deselection unmounts the previous `TerminalPane`.

- [x] **Step 3: Implement the session-scoped terminal cache**

Add a ref for opened IDs and an effect that adds selected IDs and filters IDs
missing from the latest session list. Build the carousel item list from the
current selected panes first, then cached available sessions. Set `cached` only
for IDs absent from `selectedIDs`; keep the existing terminal render callback
and keys unchanged. Keep the empty-state action when no selected pane exists,
while allowing the hidden carousel tree to retain cached children.

- [x] **Step 4: Run focused App and carousel tests**

Run: `cd web && npm test -- --run src/App.test.tsx src/components/PaneCarousel.test.tsx`

Expected: all focused tests pass.

### Task 3: Full verification and integration

**Files:**
- Modify: `web/e2e/euphony.spec.ts`
- Modify: `web/e2e/terminal-reliability.spec.ts`
- Review: `AGENTS.md`
- Review: `docs/superpowers/specs/2026-07-31-terminal-switch-keep-alive-design.md`
- Review: `docs/superpowers/plans/2026-07-31-terminal-switch-keep-alive.md`

- [x] **Step 1: Run frontend tests and type checking**

Run: `cd web && npm test -- --run && npm run typecheck`

Expected: all Vitest files pass and TypeScript exits successfully.

- [x] **Step 2: Run Go tests and the relevant Playwright suite**

Run:

```bash
go test ./...
cd web && npx playwright test --workers=1
```

Expected: all Go tests and browser tests pass using the project's isolated
test backend configuration.

- [x] **Step 3: Review the worktree and commit**

Run: `git diff --check && git status --short`

Stage only the design, plan, carousel, and App files and commit with:

```text
fix: keep terminal views alive across switches
```
