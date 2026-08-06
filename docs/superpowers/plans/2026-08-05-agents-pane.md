# Agents Pane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persisted, LLM-generated Agents dashboard for action-required and running sessions.

**Architecture:** Extend the existing session settings and SQLite store with a provider choice and one summary row per terminal. A backend `internal/agentsummary` coordinator gathers bounded transcript/PTY context, invokes the selected local CLI, persists JSON summaries, and publishes control events. The React app loads those summaries, adds an Agents navigation item, and renders a focused dashboard that can return to a terminal.

**Tech Stack:** Go, SQLite through the existing store, `os/exec`, React 19, TypeScript, Vitest, Testing Library, Playwright, existing shadcn sidebar primitives.

## Global Constraints

- Communicate with users in Japanese; write code and repository materials in English.
- All implementation changes stay in `tmp/worktrees/agents-pane` until committed and merged.
- The provider values are exactly `claude` and `codex`.
- Claude runs `claude -p --model haiku --effort low`; Codex runs `codex -c model_reasoning_effort=low -c service_tier=standard exec --model gpt-5.6-luna`.
- Running summaries refresh every five minutes and on status changes; action-required summaries refresh when entering or changing `waiting`/`blocked`.
- Transcript and terminal input are bounded before they reach the provider.
- Existing terminal selection, URL state, sidebar pin/filter behavior, and settings are preserved.

---

### Task 1: Persist summary data and provider setting

**Files:**
- Modify: `internal/session/manager.go`
- Modify: `internal/session/sqlite_store.go`
- Modify: `internal/session/sqlite_store_test.go`
- Modify: `internal/server/settings.go`
- Modify: `internal/server/settings_test.go`
- Test: `internal/session/agent_summary_test.go`

**Interfaces:**
- Produces `session.AgentSummary`, `Manager.AgentSummaries()`, `Manager.SaveAgentSummary(context.Context, AgentSummary)`, and `Manager.DeleteAgentSummary(context.Context, string)` for the coordinator and server.
- Produces `Settings.AgentSummaryProvider` with default `claude` and validation for `claude`/`codex`.

- [ ] **Step 1: Write the failing persistence tests.**

Add tests that open a persistent manager, save a summary with provider, action,
timestamp, and error, reopen the database, and assert the exact summary is
returned. Add a migration test that creates the legacy settings table without
the new column and asserts `LoadSettings` returns provider `claude`. Add server
settings cases that accept both providers and reject any other string.

- [ ] **Step 2: Run the tests to verify they fail.**

Run `go test ./internal/session ./internal/server -run 'Test.*AgentSummary|TestSettingsAPI' -count=1`.
Expected: compilation or assertion failures because the summary type, column,
manager methods, and provider field do not yet exist.

- [ ] **Step 3: Implement the minimum persistence layer.**

Add the summary type and an in-memory map to `Manager`. Add an optional summary
store interface so existing test stores remain valid. Add an
`agent_summaries` table and migration, load rows during
`NewPersistentManager`, and persist rows through the existing store operation
queue. Add `agent_summary_provider TEXT NOT NULL DEFAULT 'claude'` to SQLite
settings and include it in load/save. Extend the settings JSON decoder and
validator with the exact two allowed values.

- [ ] **Step 4: Run the focused tests to verify they pass.**

Run `go test ./internal/session ./internal/server -run 'Test.*AgentSummary|TestSettingsAPI' -count=1`.
Expected: all focused persistence and settings tests pass.

- [ ] **Step 5: Commit the persistence slice.**

Run `git add internal/session internal/server/settings.go internal/server/settings_test.go` and `git commit -m "feat: persist agent summaries"`.

### Task 2: Build the summary prompt, CLI runner, and scheduler

**Files:**
- Create: `internal/agentsummary/runner.go`
- Create: `internal/agentsummary/prompt.go`
- Create: `internal/agentsummary/service.go`
- Create: `internal/agentsummary/service_test.go`

**Interfaces:**
- Consumes `session.Manager` metadata/history/summary methods and a control event source.
- Produces `agentsummary.Service.Start()` and `Service.Close(context.Context)`.

- [ ] **Step 1: Write failing unit tests.**

Test the prompt builder with a transcript page and terminal bytes containing
ANSI escape sequences; assert both bounded contexts and the current status are
present while control sequences are absent. Test the runner with an injected
`exec.CommandContext` factory and assert the exact Claude and Codex argument
lists. Test JSON output extraction for valid JSON, fenced JSON, and malformed
output. Test the scheduler with a short injected interval: a status update
causes one run, a running tick causes one run, concurrent triggers do not
overlap, and a changed status prevents a stale result from being saved.

- [ ] **Step 2: Run the tests to verify they fail.**

Run `go test ./internal/agentsummary -run 'Test' -count=1`.
Expected: package or symbol failures because the package does not exist.

- [ ] **Step 3: Implement prompt and runner.**

Create a prompt builder that accepts metadata, parsed transcript entries, and
terminal tail text. Limit terminal bytes to 24 KiB and transcript output to 40
entries/64 KiB. Use `exec.CommandContext` without a shell, write the prompt to
stdin, cap stdout/stderr at 64 KiB, apply a 90-second timeout, and parse the
requested `{summary, action}` object. Normalize whitespace and trim each field
to a safe UI length.

- [ ] **Step 4: Implement the scheduler.**

Subscribe to `agent.updated` and `terminal.deleted`. Track the latest
agent/session/status tuple, schedule identified agents at startup, schedule on
status transitions, and tick running agents every configured interval (five
minutes in production). Use a per-terminal in-flight map and a context-aware
worker. After the provider returns, re-read metadata and save only if agent,
session ID, and status still match; otherwise schedule the current tuple.
Publish `agent.summary.updated` after a successful save and
`agent.summary.deleted` after terminal deletion.

- [ ] **Step 5: Run focused tests to verify they pass.**

Run `go test ./internal/agentsummary -run 'Test' -count=1`.
Expected: all runner, parser, prompt, and scheduling tests pass.

- [ ] **Step 6: Commit the scheduler slice.**

Run `git add internal/agentsummary` and `git commit -m "feat: generate agent summaries"`.

### Task 3: Wire the coordinator and summaries API into the server

**Files:**
- Modify: `internal/server/server.go`
- Create: `internal/server/agent_summaries.go`
- Create: `internal/server/agent_summaries_test.go`
- Modify: `internal/control/service.go`

**Interfaces:**
- Consumes `agentsummary.Service` and the existing `control.Service.Publish` method.
- Produces `GET /api/agent-summaries` returning current `[]session.AgentSummary`.

- [ ] **Step 1: Write the failing endpoint and event tests.**

Create a persistent test server, save a summary for a created terminal, request
`GET /api/agent-summaries` with bearer authentication, and assert the returned
JSON. Subscribe to `agent.summary.updated`, save/update a summary through the
coordinator-facing path, and assert the event data is the saved summary.

- [ ] **Step 2: Run the tests to verify they fail.**

Run `go test ./internal/server -run 'TestAgentSummaries' -count=1`.
Expected: route not found or missing server fields.

- [ ] **Step 3: Wire the API and lifecycle.**

Add the protected route, list only summaries whose terminal still exists and
whose status is `running`, `waiting`, or `blocked`, start the coordinator in
`server.New`, and close it before the session manager in `Server.Close`.
Expose the existing control publish method to the coordinator through its
interface without changing event envelopes.

- [ ] **Step 4: Run focused server tests.**

Run `go test ./internal/server -run 'TestAgentSummaries' -count=1`.
Expected: endpoint and event tests pass.

- [ ] **Step 5: Commit the server slice.**

Run `git add internal/server internal/control/service.go` and `git commit -m "feat: expose agent summaries"`.

### Task 4: Add frontend types, API client, and Agents dashboard

**Files:**
- Modify: `web/src/types.ts`
- Modify: `web/src/api.ts`
- Create: `web/src/components/AgentsView.tsx`
- Create: `web/src/components/AgentsView.test.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- Produces `AgentSummary`, `AgentSummaryProvider`, `ApiClient.listAgentSummaries()`, and `AgentsView`.
- `AgentsView` accepts `{ summaries, sessions, loading, error, onSelectSession }`.

- [ ] **Step 1: Write failing component tests.**

Render action-required and running summaries with matching sessions; assert
the two headings, provider/status labels, summary text, action text, empty
states, error state, and card click callback. Assert action-required cards are
ordered before running cards and that unknown session IDs are ignored.

- [ ] **Step 2: Run the tests to verify they fail.**

Run `cd web && npm test -- --run src/components/AgentsView.test.tsx`.
Expected: module or component failures because the component and types do not
exist.

- [ ] **Step 3: Implement the dashboard.**

Add typed summary API support. Implement semantic section headings and buttons
for cards. Use the planned signal rail, quiet separators, accessible status
labels, provider names, generated timestamps, loading skeleton, and concise
empty/error messages. Keep cards keyboard reachable and honor the existing
reduced-motion media rule.

- [ ] **Step 4: Run component tests and typecheck.**

Run `cd web && npm test -- --run src/components/AgentsView.test.tsx` and
`npm run typecheck`.
Expected: focused tests pass and TypeScript reports no errors.

- [ ] **Step 5: Commit the frontend component slice.**

Run `git add web/src/types.ts web/src/api.ts web/src/components/AgentsView.tsx web/src/components/AgentsView.test.tsx web/src/styles.css` and `git commit -m "feat: add agents dashboard"`.

### Task 5: Add sidebar navigation, App state, events, and settings UI

**Files:**
- Modify: `web/src/components/SessionNavigation.tsx`
- Modify: `web/src/components/SessionNavigation.test.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/types.ts`
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes `AgentsView` and `ApiClient.listAgentSummaries()`.
- Produces an Agents item at the top of the sidebar and a complete view/event/settings flow.

- [ ] **Step 1: Write failing navigation and App tests.**

Extend navigation tests to assert `Agents` appears before the terminal tree,
opens via `onOpenAgents`, and has an attention count. Add App tests that load
`/api/agent-summaries`, render the dashboard after clicking Agents, update the
dashboard on `agent.summary.updated`, and open the selected terminal when a
summary card is clicked without losing existing selection behavior. Add a
settings test that renders the provider select, saves `codex`, and includes
`agentSummaryProvider` in the PATCH body.

- [ ] **Step 2: Run tests to verify they fail.**

Run `cd web && npm test -- --run src/components/SessionNavigation.test.tsx src/App.test.tsx`.
Expected: missing props, missing API requests, and missing Agents UI failures.

- [ ] **Step 3: Implement sidebar and App wiring.**

Add `agentsOpen`, `agentSummaryCount`, and `onOpenAgents` props to
`SessionNavigation`; render a top item before `SidebarContent`. Keep the
existing terminal tree and footer behavior intact. In `App`, load summaries
when sessions load, refresh them on `agent.summary.updated` and
`agent.summary.deleted`, conditionally render `AgentsView`, and return to the
terminal pane on card selection. Do not alter URL selection unless a card is
selected.

- [ ] **Step 4: Implement provider settings.**

Add `agentSummaryProvider` to default settings and draft state. Render a
provider `<select>` with Claude/Haiku and Codex/GPT-5.6-low labels, validate
the draft client-side, reset it on load/cancel, and send it with the complete
existing settings payload. Existing saves and old settings tests must remain
compatible.

- [ ] **Step 5: Run focused frontend tests and typecheck.**

Run `cd web && npm test -- --run src/components/SessionNavigation.test.tsx src/App.test.tsx` and `npm run typecheck`.
Expected: all focused tests pass with no type errors.

- [ ] **Step 6: Commit the integration slice.**

Run `git add web/src/App.tsx web/src/App.test.tsx web/src/components/SessionNavigation.tsx web/src/components/SessionNavigation.test.tsx web/src/types.ts web/src/styles.css` and `git commit -m "feat: connect agents pane to workspace"`.

### Task 6: Verify the complete feature and integrate the branch

**Files:**
- Modify: `web/e2e/euphony.spec.ts`
- Modify: `internal/server/openapi.json` only if the new non-v1 endpoint is documented there.

- [ ] **Step 1: Add a browser-level dashboard test.**

Use the existing Playwright test server and intercept `/api/agent-summaries`
with deterministic action-required and running JSON. Open Agents, assert both
sections and the action copy, then click a card and assert the terminal view is
visible. The test must not invoke an external provider.

- [ ] **Step 2: Run the full verification commands.**

Run `go test ./...`.
Run `cd web && npm test -- --run`.
Run `cd web && npm run typecheck`.
Run `cd web && npm run build`.
Run `cd web && npm run e2e -- e2e/euphony.spec.ts`.
Expected: every command exits zero with no failing tests, type errors, or build errors.

- [ ] **Step 3: Review the diff and requirements.**

Run `git diff --check`, inspect `git diff HEAD~6`, and verify: sidebar placement,
the two sections, action/current-work copy, transcript plus terminal input,
provider commands and models, status/timer triggers, SQLite persistence,
browser events, settings validation, and unchanged terminal selection.

- [ ] **Step 4: Commit any verification-only fixes.**

If the review finds a defect, add a failing regression test first, implement
the minimal fix, rerun the affected command, and commit with a focused message.

- [ ] **Step 5: Merge into the base branch.**

After fresh verification, return to the base worktree, fast-forward or merge
`feat/agents-pane`, and report the merge commit and verification output. Keep
unrelated base-worktree changes untouched.
