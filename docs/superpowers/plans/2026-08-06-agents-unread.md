# Agents Unread and Read Tabs Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Persist independent agent-summary unread state, expose a read transition, and add synchronized Unread and Read tabs to the Agents workspace.

**Architecture:** The session manager owns unread transitions and persists them in the existing SQLite agent_summaries table. A protected server endpoint marks a summary read and republishes the updated summary through the existing agent.summary.updated event. The React app treats AgentSummary.unread as the source of tab membership, marks a card read before opening its terminal, and keeps status grouping independent.

**Tech Stack:** Go, SQLite through modernc.org/sqlite, net/http method/path routing, React, TypeScript, Vitest, Testing Library, and the existing NDJSON event stream.

## Global Constraints

- New summaries are unread; existing summary rows migrated from the old schema are read.
- Only a trimmed action-text change re-notifies a summary; summary/status-only changes preserve unread state.
- Clicking a card marks it read and opens its terminal; a read-request failure keeps it unread but does not block terminal opening.
- Unread state is workspace-wide and SQLite-persisted, not browser-local or user-specific.
- Unread is independent from Metadata.NeedsAttention and agent lifecycle status.
- The Agents workspace keeps Action required and Running sections inside both tabs.
- No bulk Mark all as read action is added.
- Existing near-black terminal-first styling is preserved; use one amber unread signal and quiet read styling.
- Existing Claude provider support remains explicit; this feature does not alter provider selection.
- Preserve unrelated base-worktree changes, including D web/dist/.keep and ?? tmp/.

---

### Task 1: Persist and normalize agent-summary unread state

**Files:**
- Modify: internal/session/manager.go (AgentSummary, SaveAgentSummary, and a new MarkAgentSummaryRead method)
- Modify: internal/session/sqlite_store.go (schema migration and agent-summary queries)
- Test: internal/session/agent_summary_test.go
- Test: internal/session/sqlite_store_test.go

**Interfaces:**
- Produces AgentSummary.Unread bool serialized as the JSON field unread.
- Produces func (m *Manager) MarkAgentSummaryRead(ctx context.Context, terminalID string) (AgentSummary, error).
- Extends agentSummaryStore with MarkAgentSummaryRead(context.Context, string) error and keeps the existing operation queue and rollback behavior.
- The server task consumes the manager method and the normalized AgentSummary value.

- [ ] Step 1: Write failing manager transition tests.

Add a test that saves a first summary and asserts it is unread, marks it read, then saves summaries with the same action, whitespace-only action formatting, and a changed action. The expected transitions are:

~~~go
first := AgentSummary{TerminalID: "terminal-1", Action: "Approve the change."}
if err := manager.SaveAgentSummary(ctx, first); err != nil { t.Fatal(err) }
if got := manager.AgentSummaries()[0].Unread; !got { t.Fatal("new summary is read") }

if _, err := manager.MarkAgentSummaryRead(ctx, "terminal-1"); err != nil { t.Fatal(err) }

sameAction := first
sameAction.Summary = "Updated status only."
if err := manager.SaveAgentSummary(ctx, sameAction); err != nil { t.Fatal(err) }
if got := manager.AgentSummaries()[0].Unread; got { t.Fatal("same action re-notified") }

normalizedAction := sameAction
normalizedAction.Action = "  Approve the change.  "
if err := manager.SaveAgentSummary(ctx, normalizedAction); err != nil { t.Fatal(err) }
if got := manager.AgentSummaries()[0].Unread; got { t.Fatal("whitespace-only action re-notified") }

changedAction := normalizedAction
changedAction.Action = "Approve the new file access."
if err := manager.SaveAgentSummary(ctx, changedAction); err != nil { t.Fatal(err) }
if got := manager.AgentSummaries()[0].Unread; !got { t.Fatal("changed action stayed read") }
~~~

Also assert that MarkAgentSummaryRead is idempotent and returns an error for an unknown terminal ID. Use the existing manager test cleanup conventions.

- [ ] Step 2: Run the focused tests and verify the expected failure.

Run:

~~~bash
GOCACHE=/private/tmp/euphony-go-cache-agents-unread go test ./internal/session -run 'Test.*AgentSummary.*Unread|Test.*MarkAgentSummaryRead' -count=1
~~~

Expected: FAIL because Unread and MarkAgentSummaryRead do not yet exist.

- [ ] Step 3: Add the unread field and manager transition rules.

Add Unread bool to AgentSummary. In SaveAgentSummary, while holding the manager lock, normalize only the previous and incoming action with strings.TrimSpace:

~~~go
if previous, ok := m.agentSummaries[summary.TerminalID]; ok {
	if strings.TrimSpace(previous.Action) != strings.TrimSpace(summary.Action) {
		summary.Unread = true
	} else {
		summary.Unread = previous.Unread
	}
} else {
	summary.Unread = true
}
~~~

Keep the current rollback logic so a failed store write restores the exact previous summary. Implement MarkAgentSummaryRead with the same lock, ErrNotFound behavior used by the manager, and queued persistence. It sets only Unread=false; it does not change status, action, summary text, or timestamps.

- [ ] Step 4: Add SQLite schema and query migration.

Add unread INTEGER NOT NULL DEFAULT 0 to the fresh agent_summaries table. Use hasColumn(ctx, "agent_summaries", "unread") and ALTER TABLE agent_summaries ADD COLUMN unread INTEGER NOT NULL DEFAULT 0 for existing databases. Include the column in LoadAgentSummaries scans and the SaveAgentSummary upsert. Implement agentSummaryStore.MarkAgentSummaryRead by updating one row's unread value and returning a wrapped error when the SQL update fails.

- [ ] Step 5: Extend persistence and migration tests.

Update the round-trip summary fixture to include Unread, and add a legacy database fixture that creates agent_summaries without the column, inserts one row, opens it through OpenSQLiteStore, and verifies the row loads with Unread=false. Reopen the database after a manager read transition and verify the false value persists.

- [ ] Step 6: Run the focused backend tests and commit.

Run:

~~~bash
gofmt -w internal/session/manager.go internal/session/sqlite_store.go internal/session/agent_summary_test.go internal/session/sqlite_store_test.go
GOCACHE=/private/tmp/euphony-go-cache-agents-unread go test ./internal/session -count=1
~~~

Commit the self-contained backend persistence change:

~~~bash
git add internal/session/manager.go internal/session/sqlite_store.go internal/session/agent_summary_test.go internal/session/sqlite_store_test.go
git commit -m "feat: persist agent summary unread state"
~~~

---

### Task 2: Add the protected read endpoint and event publication

**Files:**
- Modify: internal/server/server.go (protected route)
- Modify: internal/server/agent_summaries.go (read handler)
- Test: internal/server/agent_summaries_test.go

**Interfaces:**
- Consumes session.Manager.MarkAgentSummaryRead(context.Context, string).
- Produces POST /api/agent-summaries/{terminalID}/read returning the updated session.AgentSummary.
- Publishes agent.summary.updated with the returned summary through s.control after a successful read.
- Returns the repository's existing JSON error shape for an unknown summary.

- [ ] Step 1: Write failing endpoint and event tests.

Create a current agent session, save a summary, and issue a protected request:

~~~go
response := performRequest(t, srv, http.MethodPost,
	"/api/agent-summaries/"+summary.TerminalID+"/read", "")
if response.Code != http.StatusOK { t.Fatalf("status = %d", response.Code) }
var got session.AgentSummary
decodeResponse(t, response, &got)
if got.Unread { t.Fatal("read response remained unread") }
~~~

Subscribe to agent.summary.updated before the request and assert the event payload contains the same terminal ID and Unread=false. Add a not-found request assertion and preserve the existing list-order test.

- [ ] Step 2: Run the endpoint tests and verify the expected failure.

Run:

~~~bash
GOCACHE=/private/tmp/euphony-go-cache-agents-unread go test ./internal/server -run 'TestAgentSummary.*Read|TestAgentSummariesEndpoint' -count=1
~~~

Expected: FAIL because the route and handler do not yet exist.

- [ ] Step 3: Implement the route and handler.

Register:

~~~go
protected.HandleFunc("POST /api/agent-summaries/{id}/read", server.markAgentSummaryRead)
~~~

In markAgentSummaryRead, call the manager method with r.Context() and r.PathValue("id"). On success publish s.control.Publish("agent.summary.updated", summary) and writeJSON the summary with HTTP 200. Map session.ErrNotFound to the existing not-found response helper; pass through other errors using the existing internal-error pattern.

- [ ] Step 4: Run server tests and commit.

Run:

~~~bash
gofmt -w internal/server/server.go internal/server/agent_summaries.go internal/server/agent_summaries_test.go
GOCACHE=/private/tmp/euphony-go-cache-agents-unread go test ./internal/server -count=1
~~~

Commit:

~~~bash
git add internal/server/server.go internal/server/agent_summaries.go internal/server/agent_summaries_test.go
git commit -m "feat: add agent summary read endpoint"
~~~

---

### Task 3: Add the Web unread/read tabs and read transition wiring

**Files:**
- Modify: web/src/types.ts (AgentSummary.unread)
- Modify: web/src/api.ts (ApiClient.markAgentSummaryRead)
- Modify: web/src/components/AgentsView.tsx
- Modify: web/src/styles.css
- Modify: web/src/App.tsx
- Test: web/src/api.test.ts
- Test: web/src/components/AgentsView.test.tsx
- Test: web/src/App.test.tsx

**Interfaces:**
- Consumes the backend AgentSummary.unread field and POST /api/agent-summaries/{id}/read endpoint.
- Produces ApiClient.markAgentSummaryRead(id: string): Promise<AgentSummary>.
- AgentsView receives an async-capable onSelectSession(id: string) callback; the App callback marks read and then selects the terminal.
- Existing SSE replacement by terminalId remains the single event-state update path.

- [ ] Step 1: Write failing API and component tests.

Add an API test that verifies:

~~~ts
await api.markAgentSummaryRead("terminal-1");
expect(fetchMock).toHaveBeenCalledWith(
  "/api/agent-summaries/terminal-1/read",
  expect.objectContaining({ method: "POST" }),
);
~~~

Extend AgentsView fixtures with unread values. Test that the default Unread tab contains only unread cards, the Read tab contains only read cards, both tabs expose counts, and switching tabs preserves Action required and Running sections. Test keyboard activation of an unread card calls the selection callback.

Add App coverage that mocks the read endpoint, clicks a card, asserts the read request occurs before the terminal selection, and verifies an updated summary with unread: true moves back to the Unread tab. Add a failed-read case that still selects the terminal and keeps the card in Unread with an error message.

- [ ] Step 2: Run the focused Web tests and verify the expected failure.

Run:

~~~bash
cd web
npm test -- --run src/api.test.ts src/components/AgentsView.test.tsx src/App.test.tsx
~~~

Expected: FAIL because the type, API method, tabs, and read callback do not yet exist.

- [ ] Step 3: Add the API method and model field.

Add unread: boolean to AgentSummary and implement:

~~~ts
markAgentSummaryRead(id: string): Promise<AgentSummary> {
  return this.request("/api/agent-summaries/" + encodeURIComponent(id) + "/read", {
    method: "POST",
    body: JSON.stringify({}),
  });
}
~~~

Keep URL encoding consistent with all other ID-based API methods.

- [ ] Step 4: Implement AgentsView tabs and card state presentation.

Add local tab state initialized to "unread", derive visibleItems by filtering summary.unread === (tab === "unread"), then reuse the existing status grouping over visibleItems. Render an accessible tablist with Unread and Read buttons and each count. Keep the current card click callback, status/provider labels, and session matching.

Use an amber unread marker; give read cards a muted marker without adding a second icon system. Keep the existing loading/error layout and use distinct empty messages for the two tabs.

- [ ] Step 5: Wire App selection, event state, and failure behavior.

Change the App's openAgentTerminal path to:

~~~ts
async function openAgentTerminal(id: string) {
  try {
    const updated = await api?.markAgentSummaryRead(id);
    if (updated) {
      setAgentSummaries((current) => [
        ...current.filter((item) => item.terminalId !== updated.terminalId),
        updated,
      ]);
    }
  } catch (error) {
    setAgentSummariesError(error instanceof Error ? error.message : "Agent summary could not be marked read.");
  } finally {
    selectSession(id, false);
  }
}
~~~

Preserve the existing agent.summary.updated event replacement so a server action change with unread: true moves the card back to Unread. Clear a stale summary error after a successful list load or read request. Keep the existing dashboard count based on lifecycle status separate from the Agents tab unread count unless the current UI explicitly renders the Agents header count.

- [ ] Step 6: Add focused styles and run Web tests.

Add selectors scoped to the Agents workspace for tab focus, selected state, unread marker, muted read marker, and compact counts. Preserve visible focus and the existing responsive layout. Run:

~~~bash
cd web
npm test -- --run src/api.test.ts src/components/AgentsView.test.tsx src/App.test.tsx
npm run typecheck
~~~

Commit the frontend change:

~~~bash
git add web/src/types.ts web/src/api.ts web/src/api.test.ts web/src/components/AgentsView.tsx web/src/components/AgentsView.test.tsx web/src/App.tsx web/src/App.test.tsx web/src/styles.css
git commit -m "feat: add Agents unread and read tabs"
~~~

---

### Task 4: Integrate, verify, and prepare the branch for merge

Status: Complete. The isolated backend/Web branches were merged into
`feat/agents-unread`, the integrated suites passed, and the branch is ready
for the final fast-forward merge into `main` and push.

**Files:**
- Modify: docs/superpowers/specs/2026-08-06-agents-unread-design.md only when implementation exposes a confirmed contract mismatch; if that happens, update the affected contract and record the reason in the commit message
- Modify: docs/superpowers/plans/2026-08-06-agents-unread.md to check off completed steps
- Test: all Go and Web tests

**Interfaces:**
- Integrates the backend commits from Tasks 1–2 and the Web commit from Task 3 on feat/agents-unread.
- Produces a branch whose merge base is the pushed main commit ebe853c and whose API, persistence, event, and UI contracts agree.

- [ ] Step 1: Merge the isolated task branches without changing base worktree files.

Confirm the task branches contain only their scoped files, merge them into feat/agents-unread, and resolve only genuine overlap in shared tests or interfaces. Do not touch the base worktree's unrelated web/dist/.keep or tmp/ changes.

- [ ] Step 2: Run the complete verification suite.

Run from the feature worktree:

~~~bash
GOCACHE=/private/tmp/euphony-go-cache-agents-unread go test ./...
cd web
npm test -- --run
npm run typecheck
npm run build
~~~

Restore the tracked one-newline web/dist/.keep after the build if Vite removes it, then run git diff --check and inspect the final status.

- [ ] Step 3: Perform final review and commit any required fixes.

Review the complete diff against the design spec, specifically checking action comparison, legacy migration default, read failure behavior, event payloads, tab accessibility, and independence from NeedsAttention. Run the focused tests covering every finding before committing fixes.

- [ ] Step 4: Fast-forward merge and push.

From the base worktree, merge feat/agents-unread with --ff-only into main, verify origin/main still points at the old commit before pushing, then push the verified main branch to origin. Preserve unrelated local changes in the base worktree.
