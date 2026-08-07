# Agents Action Priority and Done Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add AI-generated action priorities and a persistent Done workflow while keeping unread state as bold text in one Agents queue.

**Architecture:** Extend the existing summary generation contract and SQLite row with `priority` and `done`. The session manager owns transitions, the server exposes an idempotent Done endpoint, and the React Agents view renders Action required and Done tabs with priority sorting and a checkmark action.

**Tech Stack:** Go, SQLite through `modernc.org/sqlite`, the existing summary command runner, net/http, React, TypeScript, Vitest, Testing Library, and Playwright.

## Global Constraints

- AI is the only source of action priority; the web UI does not allow manual editing.
- Priority values are exactly `high`, `medium`, and `low`; invalid model output is rejected for waiting and blocked summaries.
- Action changes compare trimmed text and reset both Done and unread; priority-only changes preserve both flags.
- The Agents pane has Action required and Done tabs; it has no Read or Unread tab.
- The checkmark marks the summary Done, marks it read, does not open the terminal, and moves the UI to the Done tab.
- Done state is SQLite-persisted and is independent from lifecycle status and attention state.
- Existing read behavior, event revision guards, terminal selection, dark visual language, and unrelated base-worktree changes remain intact.

---

## File map

- `internal/agentsummary/prompt.go` and `runner.go`: AI output schema, prompt rules, and validation.
- `internal/agentsummary/service.go`: copy priority into saved summaries and retain it on generation errors.
- `internal/session/manager.go` and `sqlite_store.go`: persisted fields and state transitions.
- `internal/server/agent_summaries.go` and `server.go`: protected Done route and normalized event publication.
- `web/src/types.ts` and `api.ts`: shared summary contract and Done request.
- `web/src/components/AgentsView.tsx` and `styles.css`: one unread queue, priority badges, Done tab, and checkmark control.
- `web/src/App.tsx`: Done response/event reconciliation and error handling.
- Existing focused test files beside each implementation plus `web/e2e/euphony.spec.ts` for the browser flow.

### Task 1: Extend the AI summary contract

**Files:**
- Modify: `internal/agentsummary/prompt.go`
- Modify: `internal/agentsummary/runner.go`
- Modify: `internal/agentsummary/service.go`
- Test: `internal/agentsummary/service_test.go`

**Interfaces:**
- `Generation` produces `Priority string` alongside `Summary` and `Action`.
- `ParseGeneration(output, status)` accepts only `high`, `medium`, or `low` for waiting/blocked output and returns empty priority for running output.
- `session.AgentSummary` receives the normalized generation fields in the next task.

- [x] **Step 1: Write the failing prompt and parser tests.**

Add tests that require the prompt to name the `priority` JSON field and its three allowed values, accept `{"summary":"Waiting.","action":"Approve it.","priority":"high"}` for `waiting`, reject missing and invalid priority for `blocked`, and force both action and priority empty for `running`.

```go
func TestParseGenerationValidatesActionPriority(t *testing.T) {
	got, err := ParseGeneration(`{"summary":"Waiting.","action":"Approve it.","priority":"high"}`, "waiting")
	if err != nil || got.Priority != "high" { t.Fatalf("generation = %#v, %v", got, err) }
	if _, err := ParseGeneration(`{"summary":"Blocked.","action":"Approve it.","priority":"urgent"}`, "blocked"); err == nil { t.Fatal("invalid priority accepted") }
	got, err = ParseGeneration(`{"summary":"Working.","action":"Ignore me.","priority":"high"}`, "running")
	if err != nil || got.Action != "" || got.Priority != "" { t.Fatalf("running generation = %#v, %v", got, err) }
}
```

- [x] **Step 2: Run the focused tests and confirm the expected red state.**

Run `go test ./internal/agentsummary -run 'TestBuildPrompt|TestParseGenerationValidatesActionPriority' -count=1`. It must fail because the prompt and `Generation.Priority` validation do not exist.

- [x] **Step 3: Implement the minimal AI contract.**

Add `priority` to the exact JSON shape in `BuildPrompt`, state that it is action urgency rather than lifecycle status, and add `Priority string` to `Generation`. Normalize it with `strings.TrimSpace`; clear action and priority for running; require a valid priority whenever a non-running status requires an action. Copy `generation.Priority` into both successful and previous-summary fallback results in `Service.generate` and `saveResult`.

- [x] **Step 4: Run the focused package tests and commit the contract slice.**

Run `gofmt -w internal/agentsummary/prompt.go internal/agentsummary/runner.go internal/agentsummary/service.go internal/agentsummary/service_test.go` and `go test ./internal/agentsummary -count=1`. Commit with `git add ... && git commit -m "feat: add AI action priority"`.

### Task 2: Persist Done and priority transitions

**Files:**
- Modify: `internal/session/manager.go`
- Modify: `internal/session/sqlite_store.go`
- Modify: `internal/session/agent_summary_test.go`
- Modify: `internal/session/sqlite_store_test.go`
- Modify: `internal/server/agent_summaries.go`
- Modify: `internal/server/server.go`
- Test: `internal/server/agent_summaries_test.go`

**Interfaces:**
- `AgentSummary` exposes `Priority string` as `priority` and `Done bool` as `done`.
- `Manager.MarkAgentSummaryDone(context.Context, string) (AgentSummary, error)` sets `done=true` and `unread=false`.
- `agentSummaryStore.MarkAgentSummaryDone(context.Context, string) error` persists `done=1`.
- `POST /api/agent-summaries/{id}/done` returns the normalized summary and publishes `agent.summary.updated`.

- [x] **Step 1: Write failing manager, store, and endpoint tests.**

Extend the manager transition fixture with `Priority: "high"`, assert a new summary is `Done == false`, assert Done is idempotent and clears unread, assert a same-action save preserves Done, and assert a changed action resets Done and unread. Add a legacy SQLite fixture without `priority` or `done` and verify it loads with `Priority == ""` and `Done == false`. Add a protected POST test that checks the JSON response, the published event, and a 404 for an unknown summary.

```go
done, err := manager.MarkAgentSummaryDone(context.Background(), "terminal-1")
if err != nil || !done.Done || done.Unread { t.Fatalf("done summary = %#v, %v", done, err) }
```

- [x] **Step 2: Run the focused tests and confirm they fail for missing fields and route.**

Run `go test ./internal/session ./internal/server -run 'Test.*AgentSummary.*(Done|Priority)|TestMarkAgentSummaryDone' -count=1`. Confirm the failure is caused by missing Done/priority contracts, not a test typo.

- [x] **Step 3: Add model, migration, and manager transitions.**

Add `priority TEXT NOT NULL DEFAULT ''` and `done INTEGER NOT NULL DEFAULT 0` to the fresh table and guarded `ALTER TABLE` migrations for old databases. Include both columns in load/upsert scans. In `SaveAgentSummary`, compare trimmed actions: changed action sets `Done=false` and `Unread=true`; unchanged action preserves both flags. Implement `MarkAgentSummaryDone` with the existing mutation lock, store operation queue, rollback behavior, not-found sentinel, and idempotent no-op behavior.

- [x] **Step 4: Add the protected Done endpoint and event publication.**

Register `POST /api/agent-summaries/{id}/done`, call the manager method, map `ErrAgentSummaryNotFound` to the repository's JSON 404 shape, publish through `summaryEvents`, and return HTTP 200. Keep the existing event publisher normalization so a concurrent action update cannot be overwritten by an old Done response.

- [x] **Step 5: Run backend verification and commit.**

Run `gofmt -w internal/session/manager.go internal/session/sqlite_store.go internal/session/agent_summary_test.go internal/session/sqlite_store_test.go internal/server/agent_summaries.go internal/server/server.go internal/server/agent_summaries_test.go`, then `go test ./internal/session ./internal/server ./internal/agentsummary -count=1`. Commit with `git add ... && git commit -m "feat: persist agent summary done state"`.

### Task 3: Add the one-queue Agents UI

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/api.ts`
- Modify: `web/src/components/AgentsView.tsx`
- Modify: `web/src/components/AgentsView.test.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/api.test.ts`
- Modify: `web/src/styles.css`

**Interfaces:**
- `AgentSummary` exposes optional `priority?: "high" | "medium" | "low"` for legacy rows and `done: boolean`.
- `ApiClient.markAgentSummaryDone(id: string): Promise<AgentSummary>` calls the encoded Done endpoint.
- `AgentsView` consumes `onMarkDone(id): Promise<boolean> | boolean | void` in addition to the existing terminal selection callback.

- [x] **Step 1: Write failing UI and API tests.**

Add fixtures containing high, medium, low, unread, read, and Done action summaries. Assert the Action required tab is the default, no Read/Unread tabs render, action cards appear in high-to-low order, badges contain `High priority`, `Medium priority`, and `Low priority`, unread title/body/action nodes have the unread data hook, and Done items appear only after selecting the Done tab. Assert the checkmark button calls `onMarkDone` without calling `onSelectSession` and supports keyboard activation. Add an API test for `POST /api/agent-summaries/terminal%2Fone/done`.

```ts
expect(screen.getAllByTestId("agent-summary-card").map((card) =>
	within(card).getByTestId("agent-summary-priority").textContent,
)).toEqual(["High", "Medium", "Low"]);
```

- [x] **Step 2: Run the focused Web tests and confirm the expected red state.**

Run `cd web && npm test -- --run src/api.test.ts src/components/AgentsView.test.tsx src/App.test.tsx`. It must fail because the Done API method, tabs, badges, and callback do not yet exist.

- [x] **Step 3: Implement the minimal view and API behavior.**

Add the Done API method and model fields. Replace the `unread/read` tab state with `action/done`. Filter `done === false` into Action required, preserve Action required and Running sections there, and render a Done section on the Done tab. Sort action items using `high: 0`, `medium: 1`, `low: 2`, fallback medium, then `generatedAt` descending and terminal ID. Render a separate accessible checkmark button on not-Done action cards and prevent it from opening the terminal. Keep the card body callback for marking read/opening the terminal. Render priority badge text and style unread content with bold selectors rather than a separate tab or unread dot.

- [x] **Step 4: Wire App Done reconciliation and action reopening.**

Add `markAgentSummaryDone` to `ApiClient`, extend `agentSummaryMatchesSnapshot` to include `priority` and `done`, and add `markAgentSummaryDone(id)` in `App` using the same revision bump and snapshot guard as `openAgentTerminal`. Replace the matching summary with the response, clear a successful error, and preserve the current summary on failure. Keep event replacement unchanged so a server event with `done:false` and a changed action returns a card to Action required. Have the view select Done after a successful checkmark response.

- [x] **Step 5: Run focused tests, typecheck, and commit the Web slice.**

Run `cd web && npm test -- --run src/api.test.ts src/components/AgentsView.test.tsx src/App.test.tsx` and `npm run typecheck`. Run `git diff --check`. Commit with `git add web/src/types.ts web/src/api.ts web/src/api.test.ts web/src/components/AgentsView.tsx web/src/components/AgentsView.test.tsx web/src/App.tsx web/src/App.test.tsx web/src/styles.css && git commit -m "feat: add Agents priority and done workflow"`.

### Task 4: Browser verification and integration

**Files:**
- Modify: `web/e2e/euphony.spec.ts`
- Modify: `docs/superpowers/specs/2026-08-07-agents-action-priority-done-design.md` only if a verified implementation contract differs
- Modify: `docs/superpowers/plans/2026-08-07-agents-action-priority-done.md` to check off completed steps

- [x] **Step 1: Add deterministic Playwright coverage.**

Intercept `/api/sessions`, `/api/agent-summaries`, and the event stream with one waiting high-priority unread summary, open Agents, assert the priority badge, press the checkmark, and assert the Done tab and Done card without invoking a real provider. The event-driven changed-action reopening path is covered by the App SSE regression test.

- [x] **Step 2: Run the complete verification suite.**

Run `go test ./...`, `cd web && npm test -- --run`, `npm run typecheck`, `npm run build`, and the focused Playwright spec with `npm run e2e -- e2e/euphony.spec.ts`. If the known WorkspaceFilesView timing test flakes, rerun that test alone and record the actual result rather than changing unrelated code.

- [x] **Step 3: Run React Doctor and inspect the final diff.**

Run `npx react-doctor@latest --verbose --scope changed` and confirm the changed-file score does not regress. Run `git diff --check`, inspect `git status --short`, and verify all Global Constraints against the spec.

- [x] **Step 4: Commit documentation updates and merge automatically.**

Check off the completed plan steps, commit the plan/spec bookkeeping if needed, then from the base worktree run `git merge --ff-only feat/agents-action-priority-done`. Preserve the base worktree's existing `web/dist/.keep` deletion and `tmp/` changes. Report the merge commit and fresh verification output.
