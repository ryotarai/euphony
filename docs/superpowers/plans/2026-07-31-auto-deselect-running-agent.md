# Auto-Deselect Running Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persisted, default-on setting that removes non-pinned selected terminals when their identified agent transitions into `running`.

**Architecture:** Extend the existing server-owned Settings record and SQLite singleton with one boolean. Detect session transitions at the existing snapshot boundary, pass pending IDs into the existing workspace reconciliation effect, and update the shared selection queue or non-shared URL through the current selection paths. Keep dynamic filters, pins, focused-agent promotion, and attention selection bounded by their existing semantics.

**Tech Stack:** Go, SQLite, React 19, TypeScript, Vitest, Testing Library, Playwright.

## Global Constraints

- The setting is serialized as `autoDeselectRunning` and defaults to `true` for new and migrated databases.
- Only a transition to `agentStatus === "running"` triggers the setting; initial running snapshots and repeated running snapshots do not.
- Pinned terminals remain selected; active status/CWD filters and their URL values remain unchanged.
- A same-snapshot plain-terminal-to-running-agent transition is deselected before focused-agent promotion can reselect it.
- Write tests first, run the expected failure, implement the smallest passing change, and keep the existing selection write queue authoritative in shared mode.
- Run mutating browser tests with one worker and the repository's isolated test database setup.

---

### Task 1: Persist the Settings field in the Go session store

**Files:**
- Modify: `internal/session/manager.go`
- Modify: `internal/session/sqlite_store.go`
- Test: `internal/session/sqlite_store_test.go`

**Interfaces:**
- Produces `session.Settings.AutoDeselectRunning bool` with JSON name `autoDeselectRunning`.
- `DefaultSettings`, `LoadSettings`, `SaveSettings`, and additive migration all expose the field.

- [ ] **Step 1: Write failing store tests**

Extend `TestSQLiteStorePersistsSettings` so the default assertion requires
`defaults.AutoDeselectRunning`, the saved fixture sets
`AutoDeselectRunning: false`, and the reopened value is compared with that
fixture. Extend the legacy migration expectation with
`AutoDeselectRunning: true`.

- [ ] **Step 2: Run the focused store tests and verify RED**

Run:

```bash
go test ./internal/session -run 'TestSQLiteStore(PersistsSettings|MigratesLegacySettings)' -count=1
```

Expected: compilation fails because `AutoDeselectRunning` is not yet defined.

- [ ] **Step 3: Add the field and default**

Add the field after `AutoSelectAttention` in `session.Settings` and return
`AutoDeselectRunning: true` from `DefaultSettings`.

- [ ] **Step 4: Add the idempotent SQLite migration and persistence**

Add `auto_deselect_running INTEGER NOT NULL DEFAULT 1` to the new settings
schema. After the existing `auto_select_attention` migration, check for
`auto_deselect_running` and add it with the same default when absent. Include
the column in `LoadSettings`'s query and scan, convert it to a bool, and save a
0/1 value in `SaveSettings`.

- [ ] **Step 5: Run the focused store tests and verify GREEN**

Run the same `go test ./internal/session -run ... -count=1` command and confirm
the default, false persistence, and legacy migration cases pass.

- [ ] **Step 6: Commit the store change**

```bash
git add internal/session/manager.go internal/session/sqlite_store.go internal/session/sqlite_store_test.go
git commit -m "feat: persist running-agent deselection setting"
```

### Task 2: Validate and expose the Settings API

**Files:**
- Modify: `internal/server/settings.go`
- Test: `internal/server/settings_test.go`

**Interfaces:**
- Consumes `session.Settings.AutoDeselectRunning`.
- Produces GET/PATCH JSON field `autoDeselectRunning` and rejects a PATCH body that omits it.

- [ ] **Step 1: Write failing API assertions**

Require the GET response defaults to `AutoDeselectRunning == true`. Add the
field to the valid PATCH body and expected `session.Settings`, set it to false,
and assert the response and manager settings contain false. Add the missing
field to the invalid PATCH body table so omission remains rejected.

- [ ] **Step 2: Run the focused API tests and verify RED**

Run:

```bash
go test ./internal/server -run 'TestSettingsAPI' -count=1
```

Expected: assertions or response contract fail because the new field is not
decoded and included yet.

- [ ] **Step 3: Add pointer validation and copy the field**

Add `AutoDeselectRunning *bool` to the request struct, require it to be
non-nil alongside `AutoSelectAttention`, and assign
`*input.AutoDeselectRunning` to the `session.Settings` value.

- [ ] **Step 4: Run focused and related Go tests**

Run:

```bash
go test ./internal/server -run 'TestSettingsAPI' -count=1
go test ./internal/session ./internal/server -run 'Settings' -count=1
```

Expected: all settings API, store, default, migration, and validation tests
pass.

- [ ] **Step 5: Commit the API change**

```bash
git add internal/server/settings.go internal/server/settings_test.go
git commit -m "feat: expose running-agent deselection setting"
```

### Task 3: Add frontend transition detection and selection behavior

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/App.tsx`
- Test: `web/src/App.test.tsx`

**Interfaces:**
- `Settings.autoDeselectRunning: boolean` is the browser contract.
- Produces `agentRunningTransitions(previous: Session[], next: Session[]): Session[]`.
- Consumes pending transition IDs in the existing workspace reconciliation effect.

- [ ] **Step 1: Add failing pure transition tests**

Import `agentRunningTransitions` in `App.test.tsx` and add a test that asserts
it returns only a session whose next `agentStatus` is `"running"` after a
previous non-running status. Include an already-running previous session, a
non-agent session, and a repeated running snapshot; none of those should be
returned.

- [ ] **Step 2: Run the transition test and verify RED**

Run:

```bash
cd web
npm test -- --run src/App.test.tsx -t 'detects agent running transitions'
```

Expected: the test fails because `agentRunningTransitions` does not exist.

- [ ] **Step 3: Add the frontend Settings field and draft wiring**

Add `autoDeselectRunning` to `web/src/types.ts`, the App default Settings,
every initial settings fixture, the loaded-settings draft reset, `openSettings`,
and the object passed to `persistSettings`. Add a controlled checkbox labeled
`Auto-deselect running agent terminals` with description
`Remove them from the workspace when their agent starts running.` below the
existing attention checkbox.

- [ ] **Step 4: Add transition tracking**

Implement:

```ts
export function agentRunningTransitions(
  previous: Session[],
  next: Session[],
): Session[] {
  const previousStatuses = new Map(
    previous.map((session) => [session.id, session.agentStatus]),
  );
  return next.filter(
    (session) =>
      Boolean(session.agent) &&
      session.agentStatus === "running" &&
      previousStatuses.get(session.id) !== "running",
  );
}
```

Store its IDs in a `pendingAgentRunningIDsRef` from `applySessionSnapshot`.

- [ ] **Step 5: Add failing App behavior tests**

Add fake-timer App tests that start with a selected plain terminal and poll a
same-ID Claude/Codex session with `agentStatus: "running"`:

1. With default settings, assert the terminal pane disappears, the URL has no
   `terminal` or `focus`, and a remaining terminal is not unexpectedly
   selected.
2. With `autoDeselectRunning: false`, assert the pane remains selected and the
   existing focused-agent promotion behavior still applies.
3. With a pinned selected terminal, assert it remains rendered and selected.

Use the existing `renderTerminal` probe and `vi.useFakeTimers`; keep each test
isolated with `try/finally` restoring real timers.

- [ ] **Step 6: Run the focused App tests and verify RED**

Run:

```bash
cd web
npm test -- --run src/App.test.tsx -t 'agent running|focused terminal stays selected|pinned'
```

Expected: the new transition test fails to compile first, then behavior tests
fail until the implementation is present.

- [ ] **Step 7: Consume running transitions before promotion**

In the existing workspace reconciliation effect, always read and clear the
pending running IDs. When the setting is disabled, leave them unused. When it
is enabled, remove those IDs from `selectedIDs` unless they are in `pinnedIDs`,
delete removed IDs from manual ownership, choose the retained focused ID or
first retained ID, and write the URL with `replace`. In shared mode call
`markLocalSelectionMutation` so the existing selection effect persists the
change.

Remove the same IDs from pending focused-agent promotion when this branch
handles them, then return before the promotion branch. This makes a
plain-terminal-to-running-agent snapshot deselect rather than immediately
reselect. Preserve status/CWD filters and pinned filter state.

- [ ] **Step 8: Run focused frontend tests and verify GREEN**

Run:

```bash
cd web
npm test -- --run src/App.test.tsx -t 'agent running|focused terminal stays selected|pinned'
npm test -- --run src/App.test.tsx
npm run typecheck
```

Expected: the new default-on/off/pin cases, existing agent-launch and filter
cases, the full App suite, and TypeScript checks pass.

- [ ] **Step 9: Commit the frontend behavior**

```bash
git add web/src/types.ts web/src/App.tsx web/src/App.test.tsx
git commit -m "feat(web): deselect terminals when agents start running"
```

### Task 4: Complete frontend fixtures and browser coverage

**Files:**
- Modify: `web/e2e/euphony.spec.ts`
- Modify: `web/e2e/terminal-reliability.spec.ts`
- Modify: `README.md` only if the checked-in settings documentation lists all fields

**Interfaces:**
- Consumes the persisted `autoDeselectRunning` API field and Settings label.
- Produces transport-level coverage for default-on display, false persistence,
  and running-agent deselection through the existing hook helper.

- [ ] **Step 1: Update E2E Settings fixtures**

Add `autoDeselectRunning: true` to every complete settings response/body in
the E2E fixtures and reset payloads. Keep the existing database reset and
single-worker configuration.

- [ ] **Step 2: Extend the Settings E2E flow**

In the existing Settings persistence test, assert the checkbox named
`Auto-deselect running agent terminals` is checked by default, uncheck it with
the existing attention setting, save, reload, reopen, and assert it is not
checked. Re-enable it before the test's final save if later assertions assume
the default.

- [ ] **Step 3: Add the running-agent browser scenario**

Use `clearSessions`, create two terminals, open the app, and select the first
terminal manually. Call the existing `reportAgent` helper with a running
status. With the setting enabled, assert the first terminal is removed from
the pane rail and the URL has no selected terminal. Do not use a dynamic
status filter in this scenario so it exercises direct deselection.

- [ ] **Step 4: Run focused Playwright tests**

Run:

```bash
cd web
npm run e2e -- --workers=1 --grep 'Settings|running agent|identifies it as a Claude agent'
```

Expected: the settings persistence, deselection, existing agent promotion,
and isolated browser database scenarios pass.

- [ ] **Step 5: Commit the browser coverage**

```bash
git add web/e2e/euphony.spec.ts web/e2e/terminal-reliability.spec.ts README.md
git commit -m "test(e2e): cover running-agent deselection"
```

### Task 5: Full verification and integration

**Files:**
- Verify all files changed by Tasks 1–4.

- [ ] **Step 1: Run all Go tests**

```bash
go test ./...
```

- [ ] **Step 2: Run the full Web unit suite, typecheck, and build**

```bash
cd web
npm test -- --run
npm run typecheck
npm run build
```

- [ ] **Step 3: Run the complete Playwright suite with one worker**

```bash
cd web
npm run e2e -- --workers=1
```

Use the repository's isolated test database setup and report any environment
blocker with its command output rather than treating a skipped browser run as
proof.

- [ ] **Step 4: Inspect the diff and working tree**

```bash
git diff --check
git status --short
git log --oneline -8
```

Confirm only the intended commits and files are present in the worktree.

- [ ] **Step 5: Merge the verified branch back to main**

From the base checkout, merge with:

```bash
git merge --ff-only codex/deselect-running-agent
```

Preserve the base checkout's unrelated `web/dist/.keep` deletion and
untracked `tmp/` state.
