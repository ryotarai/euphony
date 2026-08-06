# Agents Unread and Read Tabs

## Summary

The Agents workspace will separate agent summaries into `Unread` and `Read`
tabs. Unread state is persisted with each summary so it survives restarts and
is consistent across browser tabs. A newly generated summary is unread. A
summary becomes unread again when its normalized action changes. Opening a
summary card marks it read and then opens the linked terminal.

Unread state is independent from terminal lifecycle status and the existing
`needsAttention` flag. A running, waiting, or blocked agent can be either read
or unread.

## Goals

- Persist unread state in the existing SQLite agent summary record.
- Keep unread state synchronized across connected clients through the existing
  event stream.
- Move a card between the two tabs when it is read or when its action changes.
- Preserve the existing `Action required` and `Running` sections inside each
  tab.
- Treat agent status, terminal attention, and summary unread state as separate
  concepts.

## Non-goals

- Add a bulk `Mark all as read` action.
- Add browser-local or user-specific unread state.
- Change the meaning of `Metadata.NeedsAttention` or agent lifecycle statuses.
- Make summary text or status changes unread when the action is unchanged.
- Remove explicit Claude support from the provider model.

## State model and persistence

`session.AgentSummary` gains an `Unread bool` field serialized as `unread`.
The field is authoritative only after the session manager applies its update
rules; summary generators do not choose the unread state.

When `Manager.SaveAgentSummary` receives a summary:

1. If there is no previous summary for the terminal, store it as unread.
2. Compare the previous and incoming action after `strings.TrimSpace`.
3. If the normalized action changed, store the incoming summary as unread.
4. If the normalized action is unchanged, preserve the previous unread value.
5. Preserve the incoming action text itself; normalization is used only for
   comparison.

This means a still-unread item remains unread through status or summary text
updates, while a read item is re-notified only by an action change.

The SQLite `agent_summaries` table receives:

```sql
unread INTEGER NOT NULL DEFAULT 0
```

The fresh schema and the migration for existing databases both add the column.
Existing summary rows are treated as read (`0`) because they predate unread
tracking. New rows are made unread by the manager update rule, not by the SQL
default. The upsert and load queries include the new column.

`Manager.MarkAgentSummaryRead` marks an existing summary read, persists it in
the same store-operation queue used by summary writes, and returns the updated
summary. Marking an already-read summary is idempotent. An unknown terminal ID
returns a not-found error and does not create a row.

## Server API and event flow

Add a protected endpoint:

```text
POST /api/agent-summaries/{terminalID}/read
```

The endpoint calls `Manager.MarkAgentSummaryRead` and returns the updated
`AgentSummary` as JSON. A missing summary returns the existing JSON not-found
error shape.

After a successful read, the server publishes the updated summary through the
existing `agent.summary.updated` event. No new event type is required, so
clients already replacing summaries by terminal ID automatically converge.

The live summary generation path uses the same event after
`SaveAgentSummary`; the event payload must contain the manager-normalized
`unread` value. A new summary therefore appears in `Unread` on every connected
client. An action change moves an item from `Read` back to `Unread` everywhere.

The existing `agent.summary.deleted` event continues to remove summaries from
both tabs.

The frontend `ApiClient` adds `markAgentSummaryRead`. When a card is selected,
the app requests the read transition and opens the linked terminal. If the
request fails, the terminal still opens, the card remains unread, and the
existing Agents error surface receives a non-blocking error so the user can
retry later.

## Agents workspace UI

The current near-black, terminal-first visual language remains intact. The
single new visual signal is an amber unread marker and count; read cards use
the existing quiet treatment rather than a second decorative badge.

The Agents header contains a compact tablist:

```text
Unread  3        Read  8
--------------------------
```

`Unread` is selected initially. Selecting a tab filters the summaries before
the existing `Action required` and `Running` grouping is applied. The current
status colors and provider labels remain unchanged. The header count reports
the number of unread summaries, rather than replacing status with an
attention state. Empty copy distinguishes the two tabs (for example, “No
unread agent signals.” and “No read agent signals.”).

The selected tab does not change automatically when its list becomes empty;
the user can intentionally move to the other tab. Tab buttons expose proper
`tablist`, `tab`, and `tabpanel` semantics, and card activation by keyboard
uses the same read-and-open path as a pointer click.

## Error handling and concurrency

- SQLite write failures leave the in-memory summary at its previous state,
  following the existing rollback behavior of summary persistence.
- A failed read request does not hide the card or falsely report it as read.
- The read endpoint and summary update path serialize through the manager lock
  and store-operation queue. If an action update is saved after a read request,
  the action-change rule makes the summary unread again.
- Event delivery is best effort in the same way as existing summary events;
  clients reconnect and reload summaries through the existing snapshot path.

## Testing strategy

### Go

- Persist and load the unread field in SQLite.
- Migrate an existing `agent_summaries` table without the column and verify
  existing rows are read.
- Verify manager rules for a new summary, an unchanged action, a normalized
  unchanged action, and a changed action.
- Verify `MarkAgentSummaryRead` persists, is idempotent, and rejects an
  unknown summary.
- Verify the read endpoint returns the updated summary and publishes the
  existing update event.

### Web

- Verify the `ApiClient` sends the read request to the expected endpoint.
- Render summaries in the correct tab and preserve the two status sections.
- Verify tab counts, empty states, and keyboard activation.
- Verify selecting a card marks it read before opening the linked terminal,
  while a failed read keeps it unread and still opens the terminal.
- Verify an incoming updated summary with `unread: true` moves a card from
  `Read` to `Unread`.

The existing Vitest suite provides the primary UI behavior evidence; no new
browser automation is required because the behavior is fully represented by
component and App event tests.

## Scope of implementation

The implementation will touch the session summary model/store, server summary
handlers, the web API client, App event/selection wiring, AgentsView, its
styles, and focused tests. It will not refactor unrelated terminal attention
or sidebar selection behavior.
