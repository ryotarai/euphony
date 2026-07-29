# Black Terminal Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Euphony's decorative terminal chrome and custom sidebar with a flush black workspace, shadcn/ui navigation, global connection feedback, and keyboard-operable quick actions.

**Architecture:** Keep session selection and persistence in `App`, compose navigation from the installed shadcn Sidebar primitives, and report each `TerminalView` connection state to `App` for one aggregate status. Replace the hand-rolled command overlay with the shadcn Command component while retaining Euphony's existing action functions.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, shadcn/ui Base UI, cmdk, Vitest, Testing Library, Playwright

## Global Constraints

- The base color is black.
- Remove the `EU` mark.
- Terminal panes have no outer margin, gap, card border, or radius.
- Adjacent panes use one vertical divider.
- Use shadcn/ui components directly for sidebar composition.
- Group sidebar terminals as `status > cwd > terminal`.
- Persist cwd checkboxes as dynamic `status × cwd` pane filters.
- Connected state is not displayed; non-connected state is aggregated once.
- Quick actions support Arrow Up/Down, Ctrl+P/N, Enter, and Escape.
- Preserve the existing sidebar width persistence, tmux-style prefix commands, session filters, and mobile behavior.

---

### Task 1: Navigation and Flush Workspace

**Files:**
- Modify: `web/src/components/SessionNavigation.test.tsx`
- Modify: `web/src/components/SessionNavigation.tsx`
- Modify: `web/src/components/ui/sidebar.tsx`
- Modify: `web/src/styles.css`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: `SessionNavigationProps`, persisted `Settings`
- Produces: shadcn Sidebar tree with controlled width and open state

- [x] **Step 1: Write failing navigation composition tests**

Add assertions that the terminal navigation is rendered by the shadcn Sidebar,
has no `EU` text, preserves selection controls, and exposes desktop collapse,
resize, settings, and mobile sheet behavior.

- [x] **Step 2: Run the navigation test and verify it fails**

Run: `npm test -- --run src/components/SessionNavigation.test.tsx`

Expected: failure because the current navigation uses custom sidebar markup and
renders `EU`.

- [x] **Step 3: Implement the shadcn Sidebar composition**

Replace custom rail, drawer, group, and row markup with installed Sidebar
primitives. Add an opt-out for the SidebarProvider shortcut so Euphony's
`Ctrl+B` prefix remains authoritative. Keep pointer and keyboard resizing.

- [x] **Step 4: Apply black semantic tokens and flush pane rules**

Consolidate workspace overrides in `styles.css`, remove terminal-stage padding
and gap, remove pane cards and glow, and retain only adjacent vertical borders.
Add a concise reusable terminal UI rule to `AGENTS.md`.

- [x] **Step 5: Run the navigation tests**

Run: `npm test -- --run src/components/SessionNavigation.test.tsx`

Expected: all navigation tests pass.

### Task 2: Aggregate Connection Feedback

**Files:**
- Modify: `web/src/components/TerminalView.test.tsx`
- Modify: `web/src/components/TerminalView.tsx`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- Produces: `ConnectionState` and `onConnectionChange(sessionID, state)`
- Consumes: `reconnectSignal` incremented by the workspace reconnect action

- [x] **Step 1: Write failing terminal and app connection tests**

Assert that `TerminalView` reports state transitions without rendering a local
status, that a connected workspace renders no label, and that disconnected
panes produce one aggregate alert and one reconnect action.

- [x] **Step 2: Run focused tests and verify they fail**

Run: `npm test -- --run src/components/TerminalView.test.tsx src/App.test.tsx`

Expected: failure because status is currently local to every terminal.

- [x] **Step 3: Lift connection state and retry control**

Report TerminalView state changes through a callback, render a single
workspace status, and reconnect disconnected terminals when its action is
invoked.

- [x] **Step 4: Run focused tests**

Run: `npm test -- --run src/components/TerminalView.test.tsx src/App.test.tsx`

Expected: all focused tests pass.

### Task 3: Keyboard Quick Actions

**Files:**
- Create: `web/src/components/ui/command.tsx`
- Modify: `web/package.json`
- Modify: `web/package-lock.json`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`
- Modify: `web/e2e/euphony.spec.ts`

**Interfaces:**
- Consumes: existing create, notification, status-select, and session-select actions
- Produces: controlled command value with keyboard selection and invocation

- [x] **Step 1: Write failing keyboard behavior tests**

Open Quick Actions, navigate with Arrow keys and Ctrl+P/N, press Enter, and
assert the selected status or session action runs.

- [x] **Step 2: Run the App test and verify it fails**

Run: `npm test -- --run src/App.test.tsx`

Expected: failure because the hand-rolled overlay has no active item behavior.

- [x] **Step 3: Add the official shadcn Command component**

Run: `npx shadcn@latest add @shadcn/command`

Read the generated source, retain the configured Base UI style and Lucide icon
library, and compose `CommandDialog`, `CommandInput`, `CommandList`,
`CommandGroup`, and `CommandItem`.

- [x] **Step 4: Implement controlled navigation**

Keep one filtered active value. Handle Arrow Up/Down and Ctrl+P/N with
wraparound and let Enter invoke the active CommandItem.

- [x] **Step 5: Run the App tests**

Run: `npm test -- --run src/App.test.tsx`

Expected: all App tests pass.

### Task 4: Full Verification and Integration

**Files:**
- Modify: `web/e2e/euphony.spec.ts`

**Interfaces:**
- Consumes: completed workspace UI
- Produces: browser-level regression evidence

- [x] **Step 1: Add browser assertions**

Assert pane edges touch the stage, split panes have no gap, connected labels
are absent, Quick Actions execute through keyboard navigation, and the
shadcn mobile sheet opens and closes.

- [ ] **Step 2: Run full verification**

Run: `npm test -- --run`

Run: `npm run typecheck`

Run: `npm run build`

Run: `npm run e2e`

Run: `go test ./...`

Expected: every command exits zero.

- [ ] **Step 3: Inspect desktop and mobile screenshots**

Capture representative desktop split and mobile sidebar images, inspect them
for overflow, padding, pane gaps, contrast, selection clarity, and status
duplication, and fix any visible issue.

- [ ] **Step 4: Commit and merge**

Commit the task branch, merge `codex/design-black-sidebar` into `main`, run the
full unit suites on the merged tree, then remove the task worktree and branch.
