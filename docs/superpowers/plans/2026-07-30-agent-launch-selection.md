# Agent Launch Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Follow the focused terminal when it becomes an agent session and flatten the Quick Actions search field.

**Architecture:** Detect authoritative `terminal` to identified-agent transitions at the session polling boundary. Pass pending transition IDs into the existing workspace reconciliation effect, which atomically clears group filters and selects only the promoted focused session before normal dynamic-filter logic runs. Keep Quick Actions on the existing shadcn composition while making its input group borderless with one wrapper divider.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, shadcn/Base UI, Tailwind CSS 4, Playwright, Go test suite.

## Global Constraints

- Preserve the `status > cwd > terminal` dynamic filter behavior for every transition except focused plain-terminal promotion.
- Do not infer agent launch from shell input text.
- Use URL replacement for polling-driven workspace changes.
- Keep the existing black palette, Geist typography, and shadcn command composition.
- Run state-mutating Playwright tests with one worker and the configured isolated in-memory database.
- Preserve unrelated user changes in the base checkout.

---

### Task 1: Focused Agent Promotion

**Files:**
- Modify: `web/src/App.tsx`
- Test: `web/src/App.test.tsx`

**Interfaces:**
- Consumes: `sessionActivity(session: Session): string`, `previousSessionsRef`, `selectedIDs`, and `focusedID`.
- Produces: `agentLaunchTransitions(previous: Session[], next: Session[]): Session[]` and atomic promotion handling in workspace reconciliation.

- [ ] **Step 1: Write the failing integration test**

Add an App test with two selected plain terminals in the same cwd. The first
poll returns both as plain terminals. The second poll returns the focused
terminal with:

```ts
{
  ...plainTerminalSession,
  agent: "claude",
  agentStatus: "waiting",
  agentTitle: "Claude Code",
}
```

Select both terminals through the Terminal cwd checkbox, advance the 1,500 ms
poll, and assert these literal outcomes:

```ts
expect(screen.getByLabelText("session-plain terminal pane")).toBeVisible();
expect(screen.queryByLabelText("session-other terminal pane")).not.toBeInTheDocument();
expect(new URLSearchParams(location.search).getAll("terminal")).toEqual(["session-plain"]);
expect(new URLSearchParams(location.search).getAll("status")).toEqual([]);
expect(new URLSearchParams(location.search).getAll("cwd")).toEqual([]);
expect(new URLSearchParams(location.search).get("focus")).toBe("session-plain");
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd web
npm test -- --run src/App.test.tsx
```

Expected: the promoted pane disappears or the remaining plain terminal stays
selected, proving normal filter reconciliation overrides user intent.

- [ ] **Step 3: Implement transition detection**

In `App.tsx`, add:

```ts
export function agentLaunchTransitions(
  previous: Session[],
  next: Session[],
): Session[] {
  const previousActivity = new Map(
    previous.map((session) => [session.id, sessionActivity(session)]),
  );
  return next.filter(
    (session) =>
      Boolean(session.agent) &&
      previousActivity.get(session.id) === "terminal" &&
      sessionActivity(session) !== "terminal",
  );
}
```

Add `pendingAgentLaunchIDsRef = useRef<Set<string>>(new Set())`. During polling,
populate it from `agentLaunchTransitions(previousSessionsRef.current, items)`
before updating `previousSessionsRef` and `sessions`.

- [ ] **Step 4: Consume promotion before dynamic filters**

At the start of the workspace reconciliation effect:

```ts
const promotedID =
  focusedID &&
  selectedIDs.includes(focusedID) &&
  pendingAgentLaunchIDsRef.current.has(focusedID)
    ? focusedID
    : null;
pendingAgentLaunchIDsRef.current.clear();

if (promotedID) {
  filterSelectedIDsRef.current.clear();
  decomposedStatusFiltersRef.current.clear();
  setSelectedIDs([promotedID]);
  setFocusedID(promotedID);
  setStatusFilters([]);
  setCwdFilters([]);
  writeWorkspaceToURL([promotedID], promotedID, [], [], "replace");
  return;
}
```

Evaluate this branch before the existing empty-filter early return so manual
multi-selection is also reduced to the promoted pane.

- [ ] **Step 5: Verify GREEN and ordinary transitions**

Run:

```bash
cd web
npm test -- --run src/App.test.tsx
```

Expected: the new test passes, and the existing test named “a checked activity
group removes a terminal after its status changes” still passes.

- [ ] **Step 6: Commit the state change**

```bash
git add web/src/App.tsx web/src/App.test.tsx
git commit -m "fix: follow focused terminal into agent session"
```

---

### Task 2: Flat Quick Actions Search

**Files:**
- Modify: `web/src/components/ui/command.tsx`
- Modify: `web/e2e/euphony.spec.ts`

**Interfaces:**
- Consumes: existing `CommandInput` composition and `data-slot` attributes.
- Produces: a borderless `input-group` and a single bottom divider on `command-input-wrapper`.

- [ ] **Step 1: Add the browser-level visual contract**

Extend the existing Quick Actions keyboard test. After opening `Meta+K`, read
computed styles for the input group and wrapper:

```ts
const inputGroup = page.locator('[data-slot="command-input-wrapper"] [data-slot="input-group"]');
const inputWrapper = page.locator('[data-slot="command-input-wrapper"]');
await expect(inputGroup).toHaveCSS("border-top-width", "0px");
await expect(inputGroup).toHaveCSS("border-right-width", "0px");
await expect(inputGroup).toHaveCSS("border-bottom-width", "0px");
await expect(inputGroup).toHaveCSS("border-left-width", "0px");
await expect(inputGroup).toHaveCSS("box-shadow", "none");
await expect(inputWrapper).toHaveCSS("border-bottom-width", "1px");
```

The input must remain focused.

- [ ] **Step 2: Run the E2E test and verify RED**

Run:

```bash
cd web
npm run e2e -- --grep "navigates Quick Actions"
```

Expected: the current input group reports a 1 px box border and focus shadow.

- [ ] **Step 3: Flatten the shadcn input composition**

Update `CommandInput` to use:

```tsx
<div
  data-slot="command-input-wrapper"
  className="border-b border-border px-2 py-1"
>
  <InputGroup
    className="h-11! rounded-none! border-0! bg-transparent! shadow-none! ring-0! has-[[data-slot=input-group-control]:focus-visible]:border-transparent! has-[[data-slot=input-group-control]:focus-visible]:ring-0!"
  >
```

Keep the existing search icon, input semantics, disabled state, and focus
behavior.

- [ ] **Step 4: Verify the Quick Actions test**

Run:

```bash
cd web
npm run e2e -- --grep "navigates Quick Actions"
```

Expected: the style assertions and keyboard navigation pass.

- [ ] **Step 5: Commit the visual correction**

```bash
git add web/src/components/ui/command.tsx web/e2e/euphony.spec.ts
git commit -m "style: flatten quick actions search"
```

---

### Task 3: End-to-End Promotion and Workflow Rule

**Files:**
- Modify: `web/e2e/euphony.spec.ts`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: `createSession`, `reportAgent`, `/api/hooks/terminal`, and the polling interval.
- Produces: regression coverage for real API-driven promotion.

- [ ] **Step 1: Add a Playwright agent-promotion scenario**

Create two terminal sessions in one cwd, open the app, select both through the
Terminal status checkbox, and focus the first pane. Report the first session as
a waiting Claude agent with `reportAgent`. Assert after polling:

```ts
await expect(page.getByLabel("First terminal", { exact: true })).toBeVisible();
await expect(page.getByLabel("Second terminal", { exact: true })).toHaveCount(0);
expect(new URL(page.url()).searchParams.getAll("terminal")).toEqual([first.id]);
expect(new URL(page.url()).searchParams.getAll("status")).toEqual([]);
expect(new URL(page.url()).searchParams.getAll("cwd")).toEqual([]);
```

- [ ] **Step 2: Add the reusable project rule**

Append to `AGENTS.md`:

```md
- When a focused selected plain terminal becomes an identified agent session,
  clear group filters and other pane selections, then follow that session.
```

- [ ] **Step 3: Run the complete verification suite**

Run:

```bash
cd web
npm test -- --run
npm run build
npm run e2e
cd ..
go test ./...
git diff --check
```

Expected: 0 test failures, successful production build, and no whitespace
errors.

- [ ] **Step 4: Commit verification coverage and rule**

```bash
git add AGENTS.md web/e2e/euphony.spec.ts
git commit -m "test: cover focused agent promotion"
```
