# Status Filter Grace Period Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep filter-owned terminal panes visible for 10 seconds after a session update makes them stop matching the active status or cwd filter, then remove them only if the latest state still does not match.

**Architecture:** Extend the existing client-side selection reconciliation in `web/src/App.tsx`. The session snapshot callback compares the previous and current filter match for each session and starts a per-terminal timer for a selected, non-pinned filter-owned terminal that leaves the filter. The reconciliation effect treats active timers as temporary filter matches; timer expiry triggers a fresh reconciliation against the latest session state. Shared-selection reconciliation also preserves active grace-period IDs until expiry.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, fake timers.

## Global Constraints

- Keep the grace period exactly `10_000` milliseconds by reusing `runningDeselectDelayMs`.
- Delay only automatic filter-driven changes caused by session snapshots; explicit user selection, filter, pin, and deletion actions remain immediate.
- Preserve manually selected and pinned terminals.
- Clear browser timers on component unmount and never remove a terminal based on a stale snapshot.
- Write code and documentation in English; communicate with the user in Japanese.

---

### Task 1: Add failing regression tests for status-filter grace periods

**Files:**
- Modify: `web/src/App.test.tsx` near the existing dynamic status/cwd filter tests around lines 2404-2448.

**Interfaces:**
- Consumes: The existing `App`, `runningSession`, `secondRunningSession`, `plainTerminalSession`, `jsonResponse`, `expectTerminalPaneHidden`, and fake-timer setup.
- Produces: Regression coverage proving delayed removal, expiry behavior, and cancellation when the session returns to the filtered status.

- [ ] **Step 1: Write the failing delayed-removal test**

Add a test named `delays removing a filter-owned terminal until its status settles` that:

1. Starts with the URL `/?terminal=session-1&status=running`.
2. Returns `[runningSession, secondRunningSession]` for the initial `/api/sessions` request.
3. Returns `[{ ...runningSession, agentStatus: "waiting" }, secondRunningSession]` for later polls.
4. Renders each pane with an accessible label `${session.id} terminal pane` and uses `syncSelection={false}`.
5. Advances the first poll by `1_500` ms and asserts `session-1` remains visible.
6. Advances `9_000` ms and asserts `session-1` is still visible.
7. Advances `1_000` ms and waits for `session-1` to be hidden while `session-2` is visible.

The assertions must describe pane visibility, not timer internals.

- [ ] **Step 2: Run the focused test to verify it fails for the current behavior**

Run:

```bash
cd web
npm test -- --run src/App.test.tsx -t "delays removing a filter-owned terminal until its status settles"
```

Expected: FAIL before 10 seconds because the current reconciliation removes `session-1` immediately after the first `running` to `waiting` snapshot.

- [ ] **Step 3: Write the failing recovery test**

Add a test named `cancels a pending filter removal when the status returns` that uses three responses:

1. Initial sessions with `session-1` running and `session-2` running.
2. A poll where `session-1` is waiting.
3. All subsequent polls where `session-1` is running again.

Use the same `running` status URL and fake timers. Advance through the first status change, then through the recovery poll, then advance at least `10_000` ms. Assert that `session-1` remains visible and `session-2` remains hidden. This must fail before the implementation because the current code removes `session-1` on the first status change.

- [ ] **Step 4: Run the focused recovery test and confirm the expected failure**

Run:

```bash
cd web
npm test -- --run src/App.test.tsx -t "cancels a pending filter removal when the status returns"
```

Expected: FAIL on the visibility assertion, not on test setup or an unrelated exception.

### Task 2: Implement per-terminal filter-removal grace periods

**Files:**
- Modify: `web/src/App.tsx` in the timer refs/callbacks around lines 560-610, shared selection application around lines 687-760, session snapshot handling around lines 905-975, and filter reconciliation around lines 1213-1426.

**Interfaces:**
- Consumes: `Session`, `SelectionSnapshot`, `matchesWorkspaceFilter`, `sessionActivity`, `filterSelectedIDsRef`, and `runningDeselectDelayMs`.
- Produces: Browser-local timer state that preserves and then removes filter-owned IDs based on the latest session snapshot.

- [ ] **Step 1: Add the failing-test-supporting timer state**

Add refs/state for `filterDeselectTimersRef` and a `filterDeselectExpiryVersion`. Add stable callbacks that start one `window.setTimeout` per terminal ID, delete the timer when it fires, and increment the expiry version. Add cleanup to the existing timer cleanup effect so unmount clears every pending filter-removal timer.

- [ ] **Step 2: Track the latest selection/filter inputs without recreating polling subscriptions**

Keep a ref containing the current `selectedIDs`, `pinnedIDs`, `statusFilters`, and `cwdFilters`, and update it on each render. Use that ref from `applySessionSnapshot`, which must remain stable for the existing polling and event-subscription effects.

- [ ] **Step 3: Start or cancel timers at the session-snapshot boundary**

In `applySessionSnapshot`, compare each known session's previous and current `matchesWorkspaceFilter` result using the current filters. When a previously matching session becomes non-matching and its ID is in `filterSelectedIDsRef`, selected, and not pinned, start its 10-second timer. When a pending ID matches again, cancel its timer. Do not start timers for the initial snapshot or for sessions that were not filter-owned.

- [ ] **Step 4: Preserve pending filter IDs during shared-selection refreshes**

In `applyServerSelection`, include active filter-removal timer IDs in the locally preserved terminal IDs when the incoming snapshot omits them. Add these IDs to `effectiveSnapshot.terminalIds` only; do not convert them to manual selection, because expiry must still allow the filter reconciliation to remove them. Preserve the current focus only when the focused ID is one of the preserved IDs, matching the existing running-deselection protection.

- [ ] **Step 5: Make filter reconciliation honor and expire the timers**

Add active filter timer IDs to the existing `pendingRunningIDs` preservation set used while building `next`. Before computing `next`, cancel pending filter timers for IDs that are no longer selected, are pinned, or match the current filters again. Add `filterDeselectExpiryVersion` to the effect dependencies so a timer expiry re-runs reconciliation. When a timer expires and the latest session is still outside the active filter, let the existing matching/selection logic remove it and update focus/URL/shared selection exactly as it does for other automatic filter changes.

- [ ] **Step 6: Run both focused tests and verify they pass**

Run:

```bash
cd web
npm test -- --run src/App.test.tsx -t "filter-owned terminal|pending filter removal"
```

Expected: Both new tests pass, with the pane retained through 9 seconds, removed after the 10-second boundary when still non-matching, and retained after recovery.

### Task 3: Regression and build verification

**Files:**
- Modify: None unless a test exposes a directly related correction in `web/src/App.tsx` or `web/src/App.test.tsx`.

**Interfaces:**
- Consumes: The completed implementation and existing web test suite.
- Produces: Fresh evidence that existing selection, running-agent delay, and frontend compilation remain valid.

- [ ] **Step 1: Run the complete web test suite**

Run `cd web && npm test -- --run` and confirm all test files and tests pass.

- [ ] **Step 2: Run the TypeScript/build checks**

Run `cd web && npm run typecheck && npm run build` and confirm both commands exit successfully.

- [ ] **Step 3: Inspect the final diff and whitespace**

Run `git diff --check` and `git diff --stat`. Confirm only the design/plan documents and the intended App/test changes are present.

- [ ] **Step 4: Commit the implementation**

```bash
git add web/src/App.tsx web/src/App.test.tsx docs/superpowers/plans/2026-08-02-status-filter-grace-period.md
git commit -m "fix(web): delay transient filter deselection"
```

