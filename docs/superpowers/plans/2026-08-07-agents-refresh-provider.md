# Agents Refresh and Summary Provider Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users reprocess every identified agent from the Agents pane and preserve the selected summary provider across application restarts.

**Architecture:** Add a server-side refresh command that asks the existing summary coordinator to enqueue all current `running`, `waiting`, and `blocked` agents, then expose it through a protected HTTP endpoint and the Agents header. Fix the SQLite provider migration so the legacy Claude-to-Codex conversion runs only before schema version 11; later startups preserve an explicitly saved provider.

**Tech Stack:** Go, SQLite, React 19, TypeScript, Vitest, Testing Library.

## Global Constraints

- Refresh targets only identified agent terminals with status `running`, `waiting`, or `blocked`.
- Refresh is asynchronous and reuses existing per-terminal in-flight and stale-result guards.
- Existing summaries remain visible until each refreshed result arrives.
- Provider values remain exactly `claude` and `codex`, with `codex` as the default for new databases.
- Existing unrelated worktree changes remain untouched.

---

### Task 1: Preserve the saved summary provider

**Files:**
- Modify: `internal/session/sqlite_store.go`
- Modify: `internal/session/agent_summary_test.go`

**Interfaces:**
- Preserve `SQLiteStore.LoadSettings` and `SQLiteStore.SaveSettings` behavior while making the legacy provider migration conditional on the schema version.

- [ ] **Step 1: Add the failing reopen regression test.**

Create a persistent manager, save settings with `AgentSummaryProvider: "claude"`, close it, reopen the same database, and assert that `Settings().AgentSummaryProvider` is still `claude`.

- [ ] **Step 2: Run the focused test and verify it fails.**

Run: `go test ./internal/session -run TestSQLiteStorePreservesSavedAgentSummaryProvider -count=1`

Expected: FAIL because the current migration rewrites `claude` to `codex` on every open.

- [ ] **Step 3: Gate the legacy migration by the pre-migration schema version.**

Read `PRAGMA user_version` before migration statements. Run the existing `claude` to `codex` compatibility update only when the version is below 11, while retaining the `codex` default for newly created settings and setting the final schema version to 11.

- [ ] **Step 4: Run focused persistence tests.**

Run: `go test ./internal/session -run 'TestSQLiteStore(Default|Preserves|Persists).*AgentSummaryProvider|TestSQLiteStoreMigrates' -count=1`

Expected: PASS, including the existing legacy migration test and the new reopen regression test.

- [ ] **Step 5: Commit the persistence fix.**

Run: `git add internal/session/sqlite_store.go internal/session/agent_summary_test.go && git commit -m "fix: preserve saved summary provider"`

### Task 2: Add server-side refresh scheduling and API

**Files:**
- Modify: `internal/agentsummary/service.go`
- Modify: `internal/agentsummary/service_test.go`
- Modify: `internal/server/server.go`
- Modify: `internal/server/agent_summaries.go`
- Modify: `internal/server/agent_summaries_test.go`

**Interfaces:**
- Add `(*agentsummary.Service).RefreshAll() int`, which returns the number of identified agent terminals queued for generation.
- Add protected `POST /api/agent-summaries/refresh`, returning `{ "queued": number }` with HTTP 202.

- [ ] **Step 1: Add failing coordinator and endpoint tests.**

Verify that `RefreshAll` schedules fresh `running`, `waiting`, and `blocked` summaries even when each already has a successful saved summary, and that the endpoint queues all three and returns the count.

- [ ] **Step 2: Run focused tests and verify they fail.**

Run: `go test ./internal/agentsummary ./internal/server -run 'Test.*Refresh' -count=1`

Expected: FAIL because the refresh method and route do not exist.

- [ ] **Step 3: Implement forced scheduling.**

Store the service context after `Start`, enumerate `ListCurrent`, filter with the existing `isAgentState`, and call `schedule` without checking `hasFreshSummary`. Keep existing in-flight/pending behavior so a refresh requested during generation is processed once more after the current run.

- [ ] **Step 4: Implement the protected HTTP handler.**

Register `POST /api/agent-summaries/refresh`, call `s.summaries.RefreshAll()`, and return the queued count with `writeJSON` and status `http.StatusAccepted`.

- [ ] **Step 5: Run focused Go tests.**

Run: `go test ./internal/agentsummary ./internal/server -run 'Test.*Refresh' -count=1`

Expected: PASS.

- [ ] **Step 6: Commit the backend slice.**

Run: `git add internal/agentsummary internal/server && git commit -m "feat: refresh all agent summaries"`

### Task 3: Add the Agents refresh button and web API

**Files:**
- Modify: `web/src/api.ts`
- Modify: `web/src/components/AgentsView.tsx`
- Modify: `web/src/components/AgentsView.test.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- Add `ApiClient.refreshAgentSummaries(): Promise<{ queued: number }>`.
- Add optional `AgentsView` props `refreshing?: boolean` and `onRefresh?(): Promise<void> | void`.

- [ ] **Step 1: Add failing API and component tests.**

Assert that the API client sends `POST /api/agent-summaries/refresh`, that the Agents header renders an accessible `Refresh` button, and that clicking it invokes the callback and disables the button while the promise is pending. Add an App test that selecting `Refresh` sends the endpoint request and surfaces a request error when it fails.

- [ ] **Step 2: Run the focused Web tests and verify they fail.**

Run: `npm test -- --run web/src/components/AgentsView.test.tsx web/src/api.test.ts web/src/App.test.tsx`

Expected: FAIL because the client method, props, button, and App handler do not exist.

- [ ] **Step 3: Implement the client and App callback.**

Add the API method, call it from an App `refreshAgentSummaries` handler, track the pending state, clear the existing Agents error on success, and keep event-driven summary updates as the source of refreshed card data.

- [ ] **Step 4: Implement the compact header control.**

Add a `Refresh` button with a `RefreshCwIcon`, `aria-label="Refresh all agent summaries"`, disabled state, and `Refreshing…` label while pending. Keep the existing near-black, flush Agents layout and add only the spacing/focus styles required for the control; respect reduced motion for any icon animation.

- [ ] **Step 5: Run Web tests and typecheck.**

Run: `npm test -- --run web/src/components/AgentsView.test.tsx web/src/api.test.ts web/src/App.test.tsx && npm run typecheck`

Expected: PASS with zero test failures and a successful typecheck.

- [ ] **Step 6: Commit the Web slice.**

Run: `git add web/src/api.ts web/src/components/AgentsView.tsx web/src/components/AgentsView.test.tsx web/src/App.tsx web/src/App.test.tsx web/src/styles.css && git commit -m "feat: add Agents refresh control"`

### Task 4: Full verification and integration

**Files:**
- Verify all files changed by Tasks 1–3.

- [ ] **Step 1: Run the complete Go suite.**

Run: `go test ./...`

Expected: PASS.

- [ ] **Step 2: Run the complete Web unit suite and build.**

Run: `cd web && npm test -- --run && npm run build`

Expected: PASS with a successful production build.

- [ ] **Step 3: Review the diff and worktree state.**

Run: `git diff HEAD^ --stat && git status --short --branch`

Confirm only the refresh/provider files and their tests are changed.

- [ ] **Step 4: Merge the verified branch back to `main`.**

From the base checkout, run: `git merge --no-ff codex/agents-refresh-provider -m "Merge agents refresh and provider persistence"`.

