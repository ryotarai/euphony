# Sidebar Process Label Implementation Plan

> For agentic workers: use superpowers:executing-plans to implement this plan task by task. Steps use checkbox syntax for tracking.

**Goal:** Show agent titles or live foreground process names in the cwd-first sidebar and remove Claude/Codex provider artwork.

**Architecture:** Add a transient processName to Go session metadata. The session manager derives an initial value from the launched command and periodically samples the PTY foreground command, emitting updates only when the normalized executable name changes. SessionNavigation resolves agentTitle, then processName, then name, while keeping its existing cwd tree and status/attention presentation.

**Tech Stack:** Go PTY/session manager, JSON metadata API, React 19, TypeScript, Testing Library, Vitest, Playwright, Vite, and Lucide React.

## Global Constraints

- Communicate with the user in Japanese; write code, tests, and repository documents in English.
- Work only in tmp/worktrees/sidebar-process-label until the verified commit is merged into main.
- Do not persist processName; it is live process state and must remain optional in JSON.
- Resolve sidebar labels in the exact order agentTitle, processName, name after trimming blank values.
- Remove provider artwork from the sidebar without changing agent status, title metadata, agent logs, or other panes.
- Preserve cwd grouping, status icons, attention dots, selection/pinning, deletion, mobile behavior, and cwd-scoped creation.
- Run frontend behavior verification with one Playwright worker and an isolated test backend/database.

---

### Task 1: Specify process-name metadata and label priority with failing tests

**Files:**
- Modify: internal/session/manager_test.go
- Modify: web/src/components/SessionNavigation.test.tsx
- Modify: web/src/types.ts

**Interfaces:**
- Consumes: existing Session metadata and SessionNavigation test fixtures.
- Produces: tests requiring optional processName metadata and label resolution that prefers non-blank agent titles, then process names, then session names.

- [ ] Step 1: Read test-quality guidance and locate current fixtures.

~~~bash
sed -n '1,360p' /Users/ryotarai/.codex/plugins/cache/openai-curated-remote/superpowers/6.2.0/skills/writing-good-tests.md
rg -n 'agentTitle|Select (Codex|Claude|Terminal)|provider|session-agent-icon|Foreground' web/src/components/SessionNavigation.test.tsx internal/session/manager_test.go
~~~

- [ ] Step 2: Add a component test for label priority.

Add three sessions with the same cwd: one with agentTitle Review changes and
processName codex, one with blank agentTitle and processName ps, and one with
both values blank and name Fallback terminal. Assert the row text contains the
three expected labels and assert no provider image with alt Claude or Codex is
present.

- [ ] Step 3: Add Go tests for process-name normalization and manager refresh.

Add a table-driven unit test for the normalizer with /usr/bin/ps -ef to ps,
codex resume abc to codex, -zsh to zsh, and blank input to blank. Add an
integration test that creates a /bin/sh session, sets the sampling interval to
zero, writes sleep 2, and waits until manager.List reports ProcessName sleep.

- [ ] Step 4: Run the new tests and confirm RED.

~~~bash
npm test -- --run web/src/components/SessionNavigation.test.tsx
go test ./internal/session -run 'Test(.*ProcessName|.*Foreground)' -count=1
~~~

Expected: the frontend behavior test fails because the component still
renders provider artwork and uses the old label, and the Go test fails because
ProcessName and manager sampling do not exist yet. Fix only test syntax errors
before proceeding.

- [ ] Step 5: Add the optional TypeScript field needed by the failing fixture.

Add processName?: string to Session in web/src/types.ts. This is a type-only
compatibility addition; the component must still fail the behavior assertion
until Task 2 and Task 3.

- [ ] Step 6: Commit the red tests and type contract.

~~~bash
git add internal/session/manager_test.go web/src/components/SessionNavigation.test.tsx web/src/types.ts
git commit -m 'test: specify sidebar process labels'
~~~

---

### Task 2: Expose and refresh the live foreground process name

**Files:**
- Modify: internal/session/session.go
- Modify: internal/session/foreground_unix.go
- Modify: internal/session/foreground_other.go
- Modify: internal/session/manager.go
- Test: internal/session/manager_test.go

**Interfaces:**
- Consumes: PTY foreground process group and existing Session.ForegroundCommand.
- Produces: Metadata.ProcessName, Session.ForegroundCommandName, and bounded manager refreshes during List.

- [ ] Step 1: Add the metadata field and process-name helper signature.

Add ProcessName string with JSON name processName to Metadata. On Unix, add
ForegroundCommandName() (string, error) to Session; on unsupported platforms
return ErrForegroundUnsupported. Keep ForegroundCommand unchanged because agent
foreground checks depend on its full command line.

- [ ] Step 2: Implement executable-name normalization.

Use the first strings.Fields token from the foreground command, trim matching
quote characters, remove one leading - used by login shells, and return
filepath.Base. Return an empty string for blank command output. Keep arguments
out of the displayed value.

- [ ] Step 3: Run focused Go tests to confirm RED at the behavior boundary.

~~~bash
go test ./internal/session -run 'Test(.*ProcessName|.*Foreground)' -count=1
~~~

Expected: normalizer and foreground method tests pass, while the manager
refresh test still fails because the manager has not sampled ProcessName yet.

- [ ] Step 4: Add manager sampling state and initialize new sessions.

Add ProcessName initialization from command.Args[0] in Manager.start. Add
foregroundProcessSampledAt to entry, foregroundProcessSampleInterval to
Manager, and a default 500ms interval. Do not add the field to SQLite queries
or saves.

- [ ] Step 5: Sample outside the manager lock and emit changed metadata.

Call refreshForegroundProcessNames from List after existing refreshes. Under the
read phase, collect running sessions whose sample interval elapsed and mark
their timestamps; outside the lock call ForegroundCommandName; under the lock
update only changed names and emit ChangeUpdated. Clear ProcessName for
non-running sessions so exited rows fall back to their stable session names.
Sampling errors must leave the previous value unchanged.

- [ ] Step 6: Run focused Go tests to verify GREEN.

~~~bash
go test ./internal/session -run 'Test(.*ProcessName|.*Foreground)' -count=1
go test ./internal/session -count=1
~~~

Expected: the new process-name tests and the complete session package pass.

- [ ] Step 7: Commit the backend implementation.

~~~bash
git add internal/session/session.go internal/session/foreground_unix.go internal/session/foreground_other.go internal/session/manager.go internal/session/manager_test.go
git commit -m 'feat: expose live terminal process names'
~~~

---

### Task 3: Render the new label and remove provider artwork

**Files:**
- Modify: web/src/components/SessionNavigation.tsx
- Modify: web/src/components/SessionNavigation.test.tsx
- Modify: web/src/styles.css

**Interfaces:**
- Consumes: Session.processName from the API and existing SessionNavigation props.
- Produces: provider-free session rows with the exact label priority and unchanged status/attention layout.

- [ ] Step 1: Add a pure label resolver beside the existing sidebar helpers.

Implement this behavior:

~~~tsx
function sessionLabel(session: Session) {
  return session.agentTitle?.trim() || session.processName?.trim() || session.name;
}
~~~

Use it for visible row and mobile-header text where the sidebar currently uses
agentTitle or name; keep accessible selection and deletion names based on the
stable session name.

- [ ] Step 2: Run the focused component test to confirm production is RED.

~~~bash
npm test -- --run web/src/components/SessionNavigation.test.tsx
~~~

Expected: the priority/provider test fails because old provider image and label
markup are still present.

- [ ] Step 3: Remove provider imports and markup.

Delete the Claude/OpenAI asset imports and agentIcon helper. Remove the
conditional image from each session row. Render sessionLabel(session) in the
existing identity span so the status icon remains the left-most session
identity marker.

- [ ] Step 4: Keep the sidebar visual hierarchy deliberate.

Adjust only selectors that assume a provider image, preserving compact Geist
typography, status icon colors, attention dot, row padding, and mobile spacing.
Remove unused session-agent-icon rules and ensure the title remains ellipsized
without overlapping the trailing attention dot or delete action.

- [ ] Step 5: Run focused frontend tests to verify GREEN.

~~~bash
npm test -- --run web/src/components/SessionNavigation.test.tsx
npm run typecheck
~~~

- [ ] Step 6: Commit the sidebar implementation.

~~~bash
git add web/src/components/SessionNavigation.tsx web/src/components/SessionNavigation.test.tsx web/src/styles.css
git commit -m 'feat: label sidebar sessions by process'
~~~

---

### Task 4: Verify API propagation and real browser behavior

**Files:**
- Modify: web/src/App.test.tsx
- Modify: web/e2e/euphony.spec.ts

**Interfaces:**
- Consumes: JSON session snapshots containing optional processName and existing agent title updates.
- Produces: integration and E2E coverage proving labels survive API refreshes and provider artwork is absent.

- [ ] Step 1: Add App-level metadata fixtures and assertions.

Extend existing fixtures with processName where plain terminal rows are rendered.
Assert that an agent title wins over its process name and a plain session
displays its process name after a snapshot refresh.

- [ ] Step 2: Update Playwright assertions for process labels.

Keep cwd tree, status icon, attention dot, and cwd-plus checks. Replace provider
icon or generic Terminal sidebar assertions with a plain process-name assertion
and an agent-title assertion. Use the existing one-worker isolated backend.

- [ ] Step 3: Run complete verification suite.

~~~bash
npm test -- --run
npm run typecheck
npm run build
go test ./...
go test -race ./internal/session
EUPHONY_E2E_PORT=18089 npm run e2e -- --workers=1
git diff --check
~~~

Expected: all tests, typecheck, build, race detector, and the complete
Playwright suite pass. The build may retain the existing Vite chunk-size warning.

- [ ] Step 4: Commit verification-only test updates.

~~~bash
git add web/src/App.test.tsx web/e2e/euphony.spec.ts
git commit -m 'test: verify sidebar process labels end to end'
~~~

---

### Task 5: Merge the verified branch

**Files:**
- No additional file changes.

**Interfaces:**
- Consumes: all commits from Tasks 1–4 and fresh verification output.
- Produces: the feature merged into main, with the task worktree and branch cleaned up while preserving unrelated user changes.

- [ ] Step 1: Inspect final diff and branch state.

~~~bash
git status --short --branch
git diff main...HEAD --stat
git log --oneline main..HEAD
~~~

Expected: only process-label implementation, tests, and docs appear; base branch
pre-existing changes are not part of feature commits.

- [ ] Step 2: Merge into main from the base checkout.

~~~bash
git checkout main
git merge --no-ff codex/sidebar-process-label -m 'Merge sidebar process labels'
~~~

- [ ] Step 3: Verify the merged tree.

Run the complete verification suite from Task 4 on main.

- [ ] Step 4: Remove only this worktree and branch.

~~~bash
git worktree remove /Users/ryotarai/work/euphony/tmp/worktrees/sidebar-process-label
git worktree prune
git branch -d codex/sidebar-process-label
~~~

Expected: unrelated worktrees and the user's pre-existing dirty changes remain untouched.

