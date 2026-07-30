# Quick Actions Recents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the five most recently executed Quick Actions first and enlarge the Quick Actions dialog.

**Architecture:** Keep recent action values in browser-local state backed by `localStorage`. Derive one visible, deduplicated action sequence from the current dynamic action catalog, use that same sequence for rendering and keyboard navigation, and scope the height overrides to the Quick Actions dialog.

**Tech Stack:** React 19, TypeScript, cmdk/shadcn UI, Vitest, Testing Library, Playwright

## Global Constraints

- Store no more than five unique action values in most-recent-first order.
- Show `Recent` only for an empty search query and never duplicate an action.
- Ignore invalid persisted data and unavailable dynamic actions.
- Keep keyboard order identical to visual order.
- Preserve the current visual language and apply height changes only to Quick Actions.

---

### Task 1: Recent Quick Action Behavior

**Files:**
- Modify: `web/src/App.tsx`
- Test: `web/src/App.test.tsx`

**Interfaces:**
- Consumes: the existing `quickActions` catalog with `value`, `label`, `detail`, `search`, `run`, and `group`.
- Produces: a persisted `recentQuickActionValues: string[]`, visible action groups, and an execution wrapper used by click and keyboard paths.

- [ ] **Step 1: Write a failing component test**

Add a test that executes six different actions, reopens Quick Actions, and
asserts that `Recent` is the first group, contains the newest five actions in
order, omits the oldest, contains no duplicates elsewhere, and writes the same
five values to `localStorage`.

- [ ] **Step 2: Verify the component test fails for the missing feature**

Run:

```bash
npm test -- --run src/App.test.tsx
```

Expected: FAIL because no `Recent` group or persisted history exists.

- [ ] **Step 3: Implement storage and visible ordering**

Add a storage key, a defensive initializer that accepts only string arrays, an
execution wrapper that prepends and deduplicates values before truncating to
five, and derived groups that exclude recent actions from their original groups
when the query is empty. Route both `onSelect` and Enter through the wrapper.

- [ ] **Step 4: Add stale-data and search assertions**

Seed `localStorage` with malformed or unavailable values, confirm only currently
available values render, then type a query and confirm `Recent` disappears while
the matching action remains searchable.

- [ ] **Step 5: Run the focused component suite**

Run:

```bash
npm test -- --run src/App.test.tsx
```

Expected: PASS.

### Task 2: Taller Quick Actions Dialog

**Files:**
- Modify: `web/src/App.tsx`
- Test: `web/e2e/euphony.spec.ts`

**Interfaces:**
- Consumes: `CommandDialog` and `CommandList` class overrides.
- Produces: a Quick Actions-specific responsive height and a flexing scroll list.

- [ ] **Step 1: Write a failing Playwright assertion**

Open Quick Actions and assert its dialog height is greater than the previous
input-plus-18rem-list layout. Execute an action, reopen the dialog, and assert
the `Recent` group precedes `Actions` and the command list remains scrollable.

- [ ] **Step 2: Verify the Playwright test fails**

Run:

```bash
npm run e2e -- --grep "shows recent Quick Actions"
```

Expected: FAIL because the dialog is not tall and has no `Recent` group.

- [ ] **Step 3: Apply scoped layout classes**

Give the Quick Actions `CommandDialog` a responsive 40rem/80vh height with
viewport-safe top positioning. Give its `Command` a minimum height of zero and
its `CommandList` `flex-1`, `min-h-0`, and no shared `max-h-72` ceiling.

- [ ] **Step 4: Re-run focused Playwright coverage**

Run:

```bash
npm run e2e -- --grep "Quick Actions"
```

Expected: PASS.

### Task 3: Full Verification and Integration

**Files:**
- Verify: `web/src/App.tsx`
- Verify: `web/src/App.test.tsx`
- Verify: `web/e2e/euphony.spec.ts`

**Interfaces:**
- Consumes: completed recent-history and dialog-layout behavior.
- Produces: a verified commit ready to merge into the base branch.

- [ ] **Step 1: Run unit, type, and build checks**

```bash
npm test -- --run
npm run typecheck
npm run build
```

- [ ] **Step 2: Run relevant end-to-end tests**

```bash
npm run e2e -- --grep "Quick Actions"
```

- [ ] **Step 3: Inspect the final diff**

Confirm the diff contains no unrelated changes, no placeholders, and no
modification to the shared command component.

- [ ] **Step 4: Commit the implementation**

```bash
git add web/src/App.tsx web/src/App.test.tsx web/e2e/euphony.spec.ts
git commit -m "feat: show recent quick actions"
```

- [ ] **Step 5: Merge into the base branch**

Merge `feature/quick-actions-recents` into the original branch while preserving
the original worktree's unrelated uncommitted files.
