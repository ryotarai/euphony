# Preserve Agent Log Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve each pane's selected source across transient removal and re-addition caused by agent status filters.

**Architecture:** Move source selection ownership from `TerminalPane` to an App-level record keyed by session ID. Keep terminal fit bookkeeping inside `TerminalPane` and report only validated user source changes to App.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library.

## Global Constraints

- Status filter membership remains dynamic.
- Terminal and agent-log components are not kept mounted solely to preserve tab selection.
- New sessions default to the Terminal source.
- No visual styling changes.

---

### Task 1: Preserve pane source selection

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `web/src/components/TerminalPane.tsx`
- Test: `web/src/App.test.tsx`
- Modify: `AGENTS.md`

**Interfaces:**
- `TerminalPane` consumes `source: PaneSource`.
- `TerminalPane` consumes `onSourceChange(source: PaneSource): void`.
- `App` stores source selections as `Record<string, PaneSource>`.

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

- [ ] **Step 3: Make `TerminalPane` controlled**

Export `PaneSource`, add `source` and `onSourceChange` props, remove its local
source state, and call `onSourceChange` after validating a requested tab value.
Retain the local `fitVersion` increment when switching from Agent log to
Terminal.

- [ ] **Step 4: Store source selections in `App`**

Add an App-level source record and a callback that updates one session entry.
Pass `paneSources[pane.id] ?? "terminal"` and the session-specific callback to
each `TerminalPane`.

- [ ] **Step 5: Record the reusable interaction rule**

Add an instruction that agent lifecycle changes must not reset a pane's
user-selected Terminal or Agent log source.

- [ ] **Step 6: Verify the regression and Web suite**

Run:

```bash
cd web
npm test -- --run src/App.test.tsx -t "keeps the agent log selected"
npm test -- --run
npm run typecheck
npm run build
```

Expected: all commands pass.

- [ ] **Step 7: Commit**

```bash
git add AGENTS.md docs/superpowers/specs/2026-07-30-preserve-agent-log-tab-design.md docs/superpowers/plans/2026-07-30-preserve-agent-log-tab.md web/src/App.tsx web/src/App.test.tsx web/src/components/TerminalPane.tsx
git commit -m "fix: preserve agent log tab across status changes"
```

