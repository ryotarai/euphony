# Terminal List Ordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render terminal rows in the existing cwd-first sidebar in attention/status order.

**Architecture:** Keep the current cwd grouping and presentation semantics. Add a small explicit row-priority comparator used when each cwd group's sessions are rendered; unread attention is a separate first-priority flag, followed by blocked, waiting, running, and terminal.

**Tech Stack:** React 19, TypeScript, Testing Library, Vitest, Vite, and the existing Playwright setup.

## Global Constraints

- Preserve cwd groups in first-seen order.
- Preserve `needsAttention` as an independent flag and keep lifecycle icons unchanged.
- Preserve input order for rows with equal priority.
- Do not change backend response ordering, selection behavior, or API contracts.

---

### Task 1: Specify the terminal row ordering

**Files:**
- Modify: `web/src/components/SessionNavigation.test.tsx`

**Interfaces:**
- Consumes: the existing `SessionNavigation` props and session metadata.
- Produces: a regression assertion for the rendered `Select …` button order.

- [x] **Step 1: Write the failing test**

Add a test that renders five sessions in the same cwd in the opposite order and
asserts the desired order:

```tsx
test("orders terminal rows by attention and lifecycle priority", () => {
  const ordered = [
    { ...sessions[0], id: "terminal", name: "Terminal", agentStatus: undefined, agentTitle: "" },
    { ...sessions[0], id: "running", name: "Running", agentStatus: "running", agentTitle: "" },
    { ...sessions[0], id: "waiting", name: "Waiting", agentStatus: "waiting", agentTitle: "" },
    { ...sessions[0], id: "blocked", name: "Blocked", agentStatus: "blocked", agentTitle: "" },
    {
      ...sessions[0],
      id: "attention",
      name: "Needs review",
      agentStatus: "waiting",
      agentTitle: "",
      needsAttention: true,
    },
  ];
  render(
    <SessionNavigation
      sessions={ordered}
      selectedIDs={[]}
      onSelect={() => undefined}
      onCreate={() => undefined}
      onDelete={() => undefined}
    />,
  );

  const labels = screen
    .getByLabelText("Terminal sessions")
    .querySelectorAll<HTMLButtonElement>(".session-select");
  expect([...labels].map((button) => button.getAttribute("aria-label"))).toEqual([
    "Select Needs review",
    "Select Blocked",
    "Select Waiting",
    "Select Running",
    "Select Terminal",
  ]);
});
```

- [x] **Step 2: Run the focused test to verify it fails**

Run:

```bash
cd web && npm test -- --run src/components/SessionNavigation.test.tsx
```

Expected: FAIL because the current implementation preserves the input order
inside the cwd group.

- [x] **Step 3: Commit the failing test**

```bash
git add web/src/components/SessionNavigation.test.tsx
git commit -m "test: specify terminal list priority"
```

### Task 2: Implement stable attention/status sorting

**Files:**
- Modify: `web/src/components/SessionNavigation.tsx`

**Interfaces:**
- Consumes: `Session.needsAttention`, `activity(session)`, and the existing
  cwd grouping helper.
- Produces: cwd groups whose child sessions render in the specified priority
  order while preserving equal-priority input order.

- [x] **Step 1: Add the explicit priority comparator**

Define the built-in status priority map near `activity`:

```tsx
const terminalRowPriority = new Map([
  ["blocked", 1],
  ["waiting", 2],
  ["running", 3],
  ["terminal", 4],
]);

function terminalPriority(session: Session) {
  if (session.needsAttention) return 0;
  return terminalRowPriority.get(activity(session)) ?? 100;
}
```

- [x] **Step 2: Sort only child rows inside each cwd group**

When producing each group, copy and sort the group's sessions by
`terminalPriority`. Use the comparator result only; JavaScript's stable sort
must preserve the original order for equal priorities. Keep the outer map's
first-seen cwd order unchanged.

- [x] **Step 3: Run the focused test to verify it passes**

Run:

```bash
cd web && npm test -- --run src/components/SessionNavigation.test.tsx
```

Expected: the component suite passes with zero failures.

- [x] **Step 4: Commit the implementation**

```bash
git add web/src/components/SessionNavigation.tsx web/src/components/SessionNavigation.test.tsx
git commit -m "fix: order terminal rows by attention and status"
```

### Task 3: Verify and integrate

**Files:**
- No additional files.

**Interfaces:**
- Consumes: the completed sidebar ordering change.
- Produces: fresh evidence from unit tests, type checking, build, and browser
  verification where applicable.

- [x] **Step 1: Run the full web verification**

Run from `web`:

```bash
npm test -- --run
npm run typecheck
npm run build
```

- [x] **Step 2: Run browser verification**

Run from `web` with one worker:

```bash
npm run e2e -- --workers=1
```

The existing browser suite should continue to render the cwd-first sidebar and
its status/attention markers.

- [x] **Step 3: Inspect the diff and commit status**

Run:

```bash
git diff --check
git status --short
```

Expected: only the focused source, test, and plan/spec documents are changed
on this branch, with no whitespace errors.
