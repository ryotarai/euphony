# Codex Blocked Status Grace Period Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax (- [ ]) for tracking.

**Goal:** Prevent transient Codex blocked hooks from becoming status/attention notifications by waiting 10 seconds for a later hook.

**Architecture:** Keep the behavior in internal/session.Manager. A per-entry pending watch owns the candidate Codex blocked update; later hooks cancel it, while an unchanged watch applies the candidate through the existing metadata save and change emission path after the grace period. The browser notification path remains unchanged.

**Tech Stack:** Go, time, existing session manager persistence/change delivery, Go tests.

## Global Constraints

- Delay Codex blocked updates for exactly 10 * time.Second in production.
- Cancel a pending blocked update when any later agent hook is received for the same terminal.
- Treat a later blocked hook as a new candidate with a fresh 10-second quiet window; never publish an older blocked candidate after a later hook.
- Do not publish, persist, or emit attention for a transient blocked update.
- Preserve immediate behavior for Claude and all non-blocked agent updates.
- Preserve the existing Codex transcript watcher after a blocked update is confirmed.
- Write code and documentation in English; communicate with the user in Japanese.

---

### Task 1: Add failing regression tests for delayed Codex blocked hooks

**Files:**
- Modify: internal/session/manager_test.go around the existing blocked-status tests near TestUpdateAgentMarksEnteringBlockedAsNeedingAttention.
- Modify: internal/control/agent_test.go, internal/server/agent_summaries_test.go, internal/server/v1_agent_test.go, and internal/agentsummary/service_test.go where generic immediate blocked-state fixtures are used.

**Interfaces:**
- Consumes: Manager, AgentUpdate, Metadata, waitFor, and the existing Codex transcript fixture helpers.
- Produces: Tests that require a per-manager blocked grace-period duration and prove delayed publication, cancellation by a later hook, preserved Claude behavior, and transcript reconciliation after confirmation.

- [ ] **Step 1: Write the failing delayed-publication test**

Add a test named TestCodexBlockedHookWaitsBeforePublishingStatus:

~~~go
manager := NewManager("/bin/sh")
manager.blockedStatusGracePeriod = 20 * time.Millisecond
metadata, err := manager.Create(context.Background(), "Codex")
// Set the agent to codex/running, then send a codex/blocked update.
// Before the grace period, assert Metadata() is still running and has no attention.
// After waitFor(..., 2*time.Second, ...), assert it is blocked with attention.
~~~

The test must assert both the immediate metadata and the eventual metadata.
Include a title in the blocked update and assert that the title is applied only
with the eventual blocked update, proving the candidate update was held as a
unit rather than publishing only its status early.

- [ ] **Step 2: Run the focused test and verify the expected failure**

Run:

~~~bash
go test ./internal/session -run TestCodexBlockedHookWaitsBeforePublishingStatus -count=1 -v
~~~

Expected: FAIL because Manager has no blocked grace-period implementation and
the current code publishes blocked immediately.

- [ ] **Step 3: Write the failing cancellation test**

Add TestCodexBlockedHookIsCanceledByLaterHook with a 20-millisecond manager
delay. Start a Codex terminal as running, send blocked, then send another
Codex running hook before the delay expires. Wait longer than the configured
delay and assert the terminal remains running, has no attention flag, and
never emits a blocked metadata change.

- [ ] **Step 4: Run the focused cancellation test and verify the expected failure**

Run:

~~~bash
go test ./internal/session -run TestCodexBlockedHookIsCanceledByLaterHook -count=1 -v
~~~

Expected: FAIL because the current code has already published the blocked
transition before the later hook arrives.

- [ ] **Step 5: Preserve and extend existing coverage**

Change the existing immediate blocked-attention test to use Claude, and keep
its assertions that entering blocked sets attention and repeated blocked hooks
do not restore acknowledged attention. Update the Codex transcript test to set
the short manager delay, wait for blocked confirmation before appending durable
transcript output, and keep its assertion that durable activity changes the
status to running while preserving attention.

Update generic control, API, and summary-service fixtures that only need to
exercise an already-available blocked state to use Claude for their blocked
fixture. These tests are not testing the Codex grace period; keeping their
immediate setup avoids adding a real 10-second wait to unrelated tests while
the Codex-specific manager tests cover the delayed behavior.

Use a recording metadata store and change handler in the Codex grace tests to
assert that the pending hook causes neither a save nor a change before expiry,
and add a Delete regression test that waits past the short delay and rejects
any late blocked change.

### Task 2: Implement the pending blocked-status watch

**Files:**
- Modify: internal/session/manager.go in entry, Manager, NewManager, UpdateAgent, watcher helpers, and session lifecycle cleanup.

**Interfaces:**
- Consumes: AgentUpdate, existing lockMetadataSaveEntry, apply persistence/change behavior, and blockedStatusGracePeriod.
- Produces: blockedStatusWatch, awaitBlockedStatus, cancellation helpers, and delayed Codex status publication.

- [ ] **Step 1: Add the pending-watch state and production default**

Add a blockedStatusWatch pointer to entry containing the candidate AgentUpdate
and a context.CancelFunc. Add blockedStatusGracePeriod (time.Duration) to
Manager and initialize it to 10 * time.Second in NewManager.

- [ ] **Step 2: Refactor the existing agent update body behind a shared apply path**

Keep UpdateAgent responsible for acquiring the metadata-save lock and deciding
whether the update is a delayed Codex blocked hook. Move the current metadata
mutation, persistence, change creation, and existing Codex activity watch setup
into an internal apply helper that accepts the already-locked entry. The helper
must cancel any pending blocked watch before applying a normal hook and must
support a timer callback applying a blocked update without re-queuing it.

- [ ] **Step 3: Queue Codex blocked hooks and return current metadata**

For an update with trimmed Agent == "codex" and trimmed Status == "blocked",
cancel the entry's previous pending watch, create a new context, store the
candidate update, release the metadata-save lock, start awaitBlockedStatus in a
goroutine, and return the unchanged current metadata. Do not save or emit a
change at this point. A later blocked hook follows the same path and resets the
quiet window from the later hook.

- [ ] **Step 4: Apply or cancel the pending watch safely**

Implement awaitBlockedStatus with a timer using the manager's configured
duration. On expiry, lock the entry, verify manager/session/watch identity, mark
the watch consumed, and invoke the shared apply helper while retaining the
per-session metadata-save lock. On any later UpdateAgent call, cancel and clear
the pending watch before applying that later update. This serialization must
prevent a later hook from being followed by an obsolete timer callback.

- [ ] **Step 5: Cancel pending watches with session lifecycle cleanup**

Call the new cancellation helper from session exit cleanup, Delete, and Close,
alongside the existing interrupt and Codex activity watcher cleanup. Ensure
cancellation is idempotent and does not emit a change.

- [ ] **Step 6: Run the focused tests and verify they pass**

Run:

~~~bash
go test ./internal/session -run 'Test(CodexBlockedHook|UpdateAgentMarksEnteringBlockedAsNeedingAttention|CodexBlockedStatusReconcilesFromTranscript)' -count=1 -v
~~~

Expected: delayed publication, cancellation, Claude immediate behavior, and
transcript reconciliation all pass.

### Task 3: Regression and final verification

**Files:**
- Modify: None unless a directly related test correction is required.

**Interfaces:**
- Consumes: The completed session-manager implementation and existing web notification path.
- Produces: Fresh evidence for backend behavior, frontend compatibility, and a clean scoped diff.

- [ ] **Step 1: Run the complete Go suite**

Run go test ./... from the repository root and record the exit code and test
result. Existing unrelated baseline failures must remain identified rather
than silently reclassified.

- [ ] **Step 2: Run focused web tests and frontend checks**

From web, run:

~~~bash
npm test -- --run src/App.test.tsx -t "attention|notification"
npm run typecheck
npm run build
~~~

The web source should not require a behavior change because the backend no
longer emits a transient needsAttention transition.

- [ ] **Step 3: Run diff hygiene checks**

Run git diff --check and git diff --stat. Confirm that only the design, plan,
session manager, related compatibility tests, and session tests are changed.

- [ ] **Step 4: Commit the implementation**

~~~bash
git add internal/session/manager.go internal/session/manager_test.go \
  internal/control/agent_test.go internal/server/agent_summaries_test.go \
  internal/server/v1_agent_test.go internal/agentsummary/service_test.go \
  docs/superpowers/specs/2026-08-07-codex-blocked-status-grace-period-design.md \
  docs/superpowers/plans/2026-08-07-codex-blocked-status-grace-period.md
git commit -m "fix: delay transient Codex blocked hooks"
~~~
