# Blocked Status First Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the Blocked session group above every other sidebar status group.

**Architecture:** Keep the change inside `SessionNavigation`'s existing
presentation-layer ordering policy. Protect the behavior with the existing
component test that renders multiple status groups and asserts their visible
heading order.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library

## Global Constraints

- Preserve all existing status labels, grouping, filtering, and session ordering.
- The ordered groups are Blocked, Need attention, Running, Waiting, Terminal,
  then unknown statuses alphabetically.
- Do not change backend response ordering or status semantics.

---

### Task 1: Prioritize the Blocked Session Group

**Files:**
- Modify: `web/src/components/SessionNavigation.test.tsx`
- Modify: `web/src/components/SessionNavigation.tsx`

**Interfaces:**
- Consumes: `Session.agentStatus: string | undefined` and the existing
  `activity(session: Session): string` result.
- Produces: `orderedActivities(sessions: Session[]): string[]` with `blocked`
  ahead of every other activity.

- [x] **Step 1: Write the failing test**

Add a blocked session to `groups terminals by their exact cwd within each
ordered status`:

```tsx
{
  ...sessions[0],
  id: "blocked",
  name: "Blocked",
  repoRoot: "/workspace/project",
  agentStatus: "blocked",
}
```

Update the literal expected headings so they begin with:

```tsx
expect(statusNames).toEqual([
  "Blocked",
  "~/work/euphony",
  "Need attention",
  "/workspace/project/tmp/worktrees/fix",
  "Running",
  "~/work/euphony",
  "Waiting",
  "~/work/euphony",
]);
```

- [x] **Step 2: Run the focused test to verify it fails**

Run:

```bash
npm test -- --run src/components/SessionNavigation.test.tsx
```

Expected: FAIL because `Blocked` sorts after the explicitly prioritized groups.

- [x] **Step 3: Write the minimal implementation**

Update the explicit activity priorities:

```tsx
const activityOrder = new Map([
  ["blocked", 0],
  ["attention", 1],
  ["running", 2],
  ["waiting", 3],
  ["terminal", 4],
]);
```

- [x] **Step 4: Run focused and full verification**

Run:

```bash
npm test -- --run src/components/SessionNavigation.test.tsx
npm test -- --run
npm run typecheck
npm run build
```

Expected: every command exits successfully with zero test failures and zero
TypeScript or build errors.

- [x] **Step 5: Commit**

```bash
git add web/src/components/SessionNavigation.test.tsx \
  web/src/components/SessionNavigation.tsx \
  docs/superpowers/plans/2026-07-30-blocked-status-first.md
git commit -m "fix: show blocked status first"
```
