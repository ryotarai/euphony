# Agents Unread and Read Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist agent-summary unread state, expose a read transition, and add synchronized Unread/Read tabs to the Agents workspace.

**Architecture:** The session manager owns unread transitions and persists them in the existing `agent_summaries` SQLite row. The server exposes `POST /api/agent-summaries/{terminalID}/read` and broadcasts the returned summary through the existing `agent.summary.updated` event. The React app keeps the server-provided `unread` value, filters the existing status sections into two tabs, and marks a card read before opening its terminal.

**Tech Stack:** Go, `database/sql` with SQLite, `net/http`, React, TypeScript, Vitest, Testing Library.

## Global Constraints

- A new summary is unread; an action change after `strings.TrimSpace` makes it unread; status or summary-only changes preserve the previous unread value.
- Existing summary rows migrated from databases without unread tracking are read.
- Clicking or keyboard-activating a card attempts to mark it read and still opens the terminal if the request fails; a failed request leaves it unread and reports a non-blocking error.
- Unread state is independent from `Metadata.NeedsAttention` and agent lifecycle status.
- Do not add browser-local/user-specific unread state or a bulk mark-all-read action.
- Keep the existing near-black Agents visual language, with an amber unread marker and count as the only new visual signal.
- Communicate with users in Japanese; write code, tests, and documentation in English.
- All implementation changes must be made in isolated worktrees under `tmp/worktrees`.

---

### Task 1: Persist and normalize unread state in the session layer

**Files:**
- Modify: `internal/session/manager.go` (`AgentSummary`, summary methods, exported errors)
- Modify: `internal/session/sqlite_store.go` (schema, migration, load, upsert)
- Test: `internal/session/agent_summary_test.go`
- Test: `internal/session/sqlite_store_test.go`

**Interfaces:**
- Produces `session.AgentSummary.Unread bool` serialized as `unread`.
- Produces `(*Manager).MarkAgentSummaryRead(context.Context, string) (AgentSummary, error)`.
- Existing `SaveAgentSummary` remains the write entry point for generated summaries and applies unread normalization before memory and persistence updates.

- [ ] **Step 1: Write the failing state-transition tests.**

Extend the manager tests with these exact cases:

```go
func TestManagerAgentSummaryUnreadTransitions(t *testing.T) {
	manager := NewManager("/bin/sh")
	first := AgentSummary{TerminalID: "terminal-1", Action: "Approve the change."}
	if err := manager.SaveAgentSummary(context.Background(), first); err != nil {
		t.Fatal(err)
	}
	got := manager.AgentSummaries()[0]
	if !got.Unread {
		t.Fatalf("new summary unread = false, want true")
	}
	if _, err := manager.MarkAgentSummaryRead(context.Background(), first.TerminalID); err != nil {
		t.Fatal(err)
	}
	if err := manager.SaveAgentSummary(context.Background(), AgentSummary{
		TerminalID: first.TerminalID, Action: "  Approve the change.  ",
	}); err != nil {
		t.Fatal(err)
	}
	if manager.AgentSummaries()[0].Unread {
		t.Fatal("whitespace-only action change made summary unread")
	}
	if err := manager.SaveAgentSummary(context.Background(), AgentSummary{
		TerminalID: first.TerminalID, Action: "Reject the change.",
	}); err != nil {
		t.Fatal(err)
	}
	if !manager.AgentSummaries()[0].Unread {
		t.Fatal("action change did not make summary unread")
	}
}
```

Also test that an unchanged action preserves an unread summary, that
`MarkAgentSummaryRead` is idempotent, and that an unknown terminal ID returns
the exported summary-not-found error.

- [ ] **Step 2: Run the focused tests and verify they fail.**

Run:

```bash
GOCACHE=/private/tmp/euphony-go-cache-agents-unread go test ./internal/session -run 'AgentSummaryUnread|MarkAgentSummaryRead' -count=1
```

Expected: compilation or assertion failures because `Unread` and the read
method do not exist yet.

- [ ] **Step 3: Add the model and manager transition logic.**

Add `Unread bool` to `AgentSummary` and the exported
`ErrAgentSummaryNotFound` error. In `SaveAgentSummary`, while holding the
manager lock:

```go
previous, hadPrevious := m.agentSummaries[summary.TerminalID]
if !hadPrevious || strings.TrimSpace(previous.Action) != strings.TrimSpace(summary.Action) {
	summary.Unread = true
} else {
	summary.Unread = previous.Unread
}
m.agentSummaries[summary.TerminalID] = summary
```

Keep the existing store-operation rollback path and restore the complete
previous summary when persistence fails. Implement
`MarkAgentSummaryRead` with the same lock, operation reservation, persistence,
rollback, and closing checks as the existing summary methods. It must return
the current summary without writing again when it is already read.

- [ ] **Step 4: Add the SQLite column and migration.**

Add `unread INTEGER NOT NULL DEFAULT 0` to the fresh `agent_summaries` table.
Use `hasColumn` to add the same column to existing databases; the default `0`
makes pre-feature rows read. Include `unread` in `SELECT`, `INSERT`, and
`ON CONFLICT ... DO UPDATE` statements. Keep generated new-row unread state in
the manager rather than relying on the SQL default.

- [ ] **Step 5: Extend persistence tests and run them green.**

Update the SQLite round-trip expectation to include `Unread`, add a migration
database without the column and verify its existing row loads with
`Unread == false`, and reopen a manager after marking a row read to verify the
false value survives. Run:

```bash
GOCACHE=/private/tmp/euphony-go-cache-agents-unread go test ./internal/session -count=1
```

Expected: PASS.

- [ ] **Step 6: Commit the session-layer task.**

```bash
git add internal/session/manager.go internal/session/sqlite_store.go internal/session/agent_summary_test.go internal/session/sqlite_store_test.go
git commit -m "feat: persist agent summary unread state"
```

### Task 2: Expose the read transition through the server

**Files:**
- Modify: `internal/server/server.go` (protected route)
- Modify: `internal/server/agent_summaries.go` (handler)
- Test: `internal/server/agent_summaries_test.go`

**Interfaces:**
- Consumes `Manager.MarkAgentSummaryRead(context.Context, string) (session.AgentSummary, error)` from Task 1.
- Produces `POST /api/agent-summaries/{terminalID}/read` returning the updated `session.AgentSummary` JSON.
- Publishes `agent.summary.updated` with the updated summary after a successful read.

- [ ] **Step 1: Write the failing endpoint and event tests.**

Create an active agent summary in the existing server test fixture, call
`POST /api/agent-summaries/{id}/read`, decode the response, and assert
`Unread == false` and that a second call remains successful and false. Subscribe
to `agent.summary.updated` before the request and assert the event contains the
same terminal ID and `Unread == false`. Add a missing-summary request and assert
the standard not-found response.

- [ ] **Step 2: Run the endpoint tests and verify they fail.**

Run:

```bash
GOCACHE=/private/tmp/euphony-go-cache-agents-unread go test ./internal/server -run 'AgentSummary.*Read|AgentSummaries.*Read' -count=1
```

Expected: route-not-found or missing-handler failures.

- [ ] **Step 3: Implement the protected route and handler.**

Register:

```go
protected.HandleFunc("POST /api/agent-summaries/{id}/read", server.markAgentSummaryRead)
```

The handler calls the manager with `r.PathValue("id")`, maps the summary
not-found error to the existing JSON not-found response, maps other failures
to the existing internal error response, writes the updated summary as JSON,
and publishes `agent.summary.updated` only after persistence succeeds.

- [ ] **Step 4: Run server tests and the full Go suite.**

Run:

```bash
GOCACHE=/private/tmp/euphony-go-cache-agents-unread go test ./internal/server ./internal/session -count=1
GOCACHE=/private/tmp/euphony-go-cache-agents-unread go test ./...
```

Expected: PASS.

- [ ] **Step 5: Commit the server task.**

```bash
git add internal/server/server.go internal/server/agent_summaries.go internal/server/agent_summaries_test.go
git commit -m "feat: add agent summary read endpoint"
```

### Task 3: Add synchronized Unread/Read Agents tabs

**Files:**
- Modify: `web/src/types.ts` (`AgentSummary.unread`)
- Modify: `web/src/api.ts` (`markAgentSummaryRead`)
- Test: `web/src/api.test.ts`
- Modify: `web/src/components/AgentsView.tsx`
- Test: `web/src/components/AgentsView.test.tsx`
- Modify: `web/src/App.tsx` (read-and-open callback, event state, unread count)
- Test: `web/src/App.test.tsx`
- Modify: `web/src/styles.css` (tabs and unread marker)

**Interfaces:**
- Consumes the server `AgentSummary.unread` field and the read endpoint from Task 2.
- Produces `ApiClient.markAgentSummaryRead(id): Promise<AgentSummary>`.
- Produces an Agents view with accessible `Unread` and `Read` tabs and existing status sections in each tab.

- [ ] **Step 1: Write the failing API and component tests.**

Add an API test asserting a `POST` request to
`/api/agent-summaries/terminal-1/read` and the returned summary. Extend the
Agents fixture with both unread and read summaries, then assert:

```tsx
expect(screen.getByRole("tab", { name: /Unread 1/ })).toHaveAttribute(
  "aria-selected",
  "true",
);
expect(screen.getByText("Unread summary")).toBeInTheDocument();
expect(screen.queryByText("Read summary")).not.toBeInTheDocument();
await user.click(screen.getByRole("tab", { name: /Read 1/ }));
expect(screen.getByText("Read summary")).toBeInTheDocument();
```

Add App coverage that resolves the read request before selecting the terminal,
keeps a failed request's summary unread, and replaces a read summary with an
incoming event carrying `unread: true`.

- [ ] **Step 2: Run the focused Web tests and verify they fail.**

Run:

```bash
npm test -- --run src/api.test.ts src/components/AgentsView.test.tsx src/App.test.tsx
```

Expected: failures because the type, API method, tabs, and read callback are
not implemented.

- [ ] **Step 3: Add the type and API method.**

Add `unread: boolean` to `AgentSummary`. Implement:

```ts
markAgentSummaryRead(id: string): Promise<AgentSummary> {
  return this.request(`/api/agent-summaries/${encodeURIComponent(id)}/read`, {
    method: "POST",
  });
}
```

- [ ] **Step 4: Implement AgentsView tab filtering and accessible activation.**

Track the selected tab locally with `useState<"unread" | "read">("unread")`.
Render a `tablist` with `Unread` and `Read` buttons and counts. Filter by
`summary.unread` before deriving `Action required` and `Running` lists. Keep
the existing card callback; keyboard activation uses the same button click
path. Use distinct empty copy for each tab and preserve missing-session
filtering.

- [ ] **Step 5: Wire read-then-open and incoming events in App.**

Change the Agents card callback to an async function that calls
`api.markAgentSummaryRead(id)` and replaces the local summary with the returned
value. Catch errors into `agentSummariesError` without preventing
`selectSession(id, false)`. Keep the item unread when the request fails. The
existing `agent.summary.updated` handler already replaces by terminal ID; keep
that behavior so the server's normalized `unread: true` action-change event
moves read cards back to Unread. Derive the Agents header count from unread
summaries without changing the separate terminal `needsAttention` logic.

- [ ] **Step 6: Add the restrained visual treatment and run focused tests.**

Add tablist focus styles, an active underline, an amber unread marker/count,
and muted read-card treatment within the existing Agents CSS. Respect the
existing reduced-motion and keyboard-focus conventions. Run:

```bash
npm test -- --run src/api.test.ts src/components/AgentsView.test.tsx src/App.test.tsx
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Run the full Web suite and commit the Web task.**

```bash
npm test -- --run
npm run build
```

Restore the tracked `web/dist/.keep` file if the production build removes it,
then commit:

```bash
git add web/src/types.ts web/src/api.ts web/src/api.test.ts web/src/components/AgentsView.tsx web/src/components/AgentsView.test.tsx web/src/App.tsx web/src/App.test.tsx web/src/styles.css web/dist/.keep
git commit -m "feat: add Agents unread and read tabs"
```

### Task 4: Integrate, review, and publish

**Files:**
- Modify: `docs/superpowers/plans/2026-08-06-agents-unread.md` (check off completed steps)
- Modify: `docs/superpowers/specs/2026-08-06-agents-unread-design.md` only if implementation reveals a factual correction

**Interfaces:**
- Consumes the committed session/server and Web task branches.
- Produces a fast-forwardable feature branch with all tests passing and no
  unrelated base-worktree changes staged.

- [ ] **Step 1: Merge the backend and Web task commits into the feature branch.**

Use `git merge --no-ff` only if required by the task branches; otherwise keep
the feature history linear with fast-forward merges. Resolve only overlapping
implementation files and preserve the existing base worktree's
`web/dist/.keep` deletion and `tmp/` directory outside commits.

- [ ] **Step 2: Run the complete verification set.**

```bash
GOCACHE=/private/tmp/euphony-go-cache-agents-unread go test ./...
cd web
npm test -- --run
npm run typecheck
npm run build
```

Restore `web/dist/.keep` after the build if necessary and run
`git diff --check`.

- [ ] **Step 3: Perform a whole-branch review.**

Review the diff from the merge base against the design spec. Confirm action
comparison, migration default, read failure behavior, event payload, tab
semantics, and independent attention state. Address any important findings
before integration.

- [ ] **Step 4: Merge into main and push origin.**

From the base worktree, fast-forward `main` to the reviewed feature commit,
verify `git rev-list --left-right --count origin/main...main` reports only the
intended local commits, and push `main` to `origin`. Re-run the status check so
the remote branch contains the implementation commit.
