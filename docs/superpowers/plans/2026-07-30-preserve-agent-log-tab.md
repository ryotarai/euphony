# Preserve Agent Log Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve each pane's selected source across transient removal and re-addition caused by agent status filters.

**Architecture:** Treat unread attention as an overlay during dynamic filter matching: an attention session matches both Attention and its actual agent lifecycle status. This prevents a spurious pane removal and preserves the mounted pane's focus and local source state.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library.

## Global Constraints

- Status filter membership remains dynamic.
- Intentional lifecycle status changes continue to update dynamic filter membership.
- Attention does not replace `running` or `waiting` during filter matching.
- No visual styling changes.

---

### Task 1: Preserve pane source selection

**Files:**
- Modify: `web/src/App.tsx`
- Test: `web/src/App.test.tsx`
- Test: `web/e2e/euphony.spec.ts`
- Modify: `AGENTS.md`

**Interfaces:**
- `matchesWorkspaceFilter` consumes one session and active status/CWD filters.
- An attention session matches its primary Attention activity and its actual
  `agentStatus`.

- [x] **Step 1: Write the failing integration test**

Add a test that selects Running and Waiting filters, opens Agent log, advances
the session poll through a waiting attention transition, and asserts that the
Agent log tab remains active.

- [x] **Step 2: Run the test to verify it fails**

Run:

```bash
cd web
npm test -- --run src/App.test.tsx -t "keeps the agent log selected"
```

Expected: FAIL because the re-added `TerminalPane` defaults to Terminal.

- [x] **Step 3: Match attention independently from lifecycle status**

Extend `matchesWorkspaceFilter` so a session with `needsAttention` also matches
its non-empty `agentStatus`. Do not change `TerminalPane` state ownership.

- [x] **Step 4: Record the reusable interaction rule**

Add an instruction that agent lifecycle changes must not reset a pane's
user-selected Terminal or Agent log source.

- [x] **Step 5: Verify the regression and Web suite**

Run:

```bash
cd web
npm test -- --run src/App.test.tsx -t "keeps the agent log selected"
npm test -- --run
npm run typecheck
npm run build
npm run e2e
```

Expected: all commands pass.

- [x] **Step 6: Commit**

```bash
git add AGENTS.md docs/superpowers/specs/2026-07-30-preserve-agent-log-tab-design.md docs/superpowers/plans/2026-07-30-preserve-agent-log-tab.md web/src/App.tsx web/src/App.test.tsx web/e2e/euphony.spec.ts
git commit -m "fix: preserve agent log tab across status changes"
```
