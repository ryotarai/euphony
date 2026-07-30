# Empty Status Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Always show the four built-in terminal activity groups in the left sidebar and render `No terminal` inside empty groups.

**Architecture:** Extend `SessionNavigation`'s activity ordering helper to seed the four built-in activities before appending session-defined values. Render one semantic empty-state line when a group contains no working-directory sections, while reusing the existing status checkbox and filter callback.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, shadcn sidebar primitives

## Global Constraints

- Render built-in groups in this order: Need attention, Running, Waiting, Terminal.
- Keep each group's existing checkbox and count badge visible at zero sessions.
- Display the exact copy `No terminal` once inside each empty group.
- Preserve unknown session activity values and sort them after built-in groups.
- Preserve existing status-filter, URL-sync, and pane-selection behavior.
- Do not add dependencies or backend changes.

---

### Task 1: Render Empty Built-in Activity Groups

**Files:**
- Modify: `web/src/components/SessionNavigation.tsx`
- Modify: `web/src/styles.css`
- Test: `web/src/App.test.tsx`

**Interfaces:**
- Consumes: `Session[]`, `statusFilters: string[]`, and `onStatusFilter(status: string, checked: boolean)` from the existing `SessionNavigationProps`.
- Produces: Sidebar groups for `attention`, `running`, `waiting`, and `terminal`, plus `.status-empty` content for groups whose filtered session list is empty.

- [ ] **Step 1: Write the failing component test**

Add a test that renders `App` with only `runningSession`, then asserts all four
status checkboxes are present and exactly three empty-state lines are rendered:

```tsx
test("shows built-in activity groups when they have no terminals", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() =>
    jsonResponse([runningSession]),
  );
  render(
    <App
      initialToken="valid-token"
      initialSettings={defaultSettings}
      renderTerminal={(session) => <div aria-label={`${session.id} terminal pane`} />}
    />,
  );

  await screen.findByLabelText("session-1 terminal pane");

  for (const label of [
    "Show all Need attention terminals",
    "Show all Running terminals",
    "Show all Waiting terminals",
    "Show all Terminal terminals",
  ]) {
    expect(screen.getByRole("checkbox", { name: label })).toBeVisible();
  }
  expect(screen.getAllByText("No terminal")).toHaveLength(3);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd web
npm test -- --run -t "shows built-in activity groups when they have no terminals"
```

Expected: FAIL because the Need attention, Waiting, and Terminal groups are
absent.

- [ ] **Step 3: Seed built-in activities and render the empty state**

In `SessionNavigation.tsx`, define the canonical built-in activity array,
derive ordering from it, and merge session activities into it:

```tsx
const builtInActivities = ["attention", "running", "waiting", "terminal"];

const activityOrder = new Map(
  builtInActivities.map((status, index) => [status, index]),
);

function orderedActivities(sessions: Session[]) {
  return [...new Set([...builtInActivities, ...sessions.map(activity)])].sort(
    (left, right) =>
      (activityOrder.get(left) ?? 100) - (activityOrder.get(right) ?? 100) ||
      left.localeCompare(right),
  );
}
```

Inside each status group's `SidebarGroupContent`, render the empty-state copy
before mapping working directories:

```tsx
{statusSessions.length === 0 && (
  <p className="status-empty">No terminal</p>
)}
```

In `styles.css`, make `.status-empty` align with nested sidebar content and use
the existing muted foreground color without adding a new visual container.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
cd web
npm test -- --run -t "shows built-in activity groups when they have no terminals"
```

Expected: PASS.

- [ ] **Step 5: Run regression verification**

Run:

```bash
cd web
npm test -- --run
npm run typecheck
npm run build
```

Expected: all 89 unit tests pass, typecheck exits successfully, and Vite
produces the production bundle.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-07-30-empty-status-groups-design.md \
  docs/superpowers/plans/2026-07-30-empty-status-groups.md \
  web/src/App.test.tsx web/src/components/SessionNavigation.tsx web/src/styles.css
git commit -m "feat: show empty terminal status groups"
```
