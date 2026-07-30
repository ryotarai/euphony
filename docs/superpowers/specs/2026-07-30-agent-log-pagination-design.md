# Agent Log Pagination Design

## Summary

Make long agent logs open in bounded time. The Agent Log endpoint will read
only the newest page of JSONL records, omit tool payloads and results from the
transport, and return consecutive tool activity as a compact count such as
`5 tool calls`. The reader starts at the newest content and can prepend older
pages with a `Load more` control at the top.

## Chosen Approach

Three approaches were considered:

1. Render only the last entries in React. This reduces DOM work but still
   reads, parses, and transfers the complete transcript.
2. Parse the complete transcript on the server and slice the response. This
   reduces DOM and network work but keeps server latency proportional to the
   full session.
3. Read bounded JSONL ranges from the file and paginate by byte cursor. This
   bounds initial file I/O, JSON parsing, response size, and DOM work.

Use approach 3. Cursors are decimal byte offsets produced by the server. They
do not identify or select a path; transcript path confinement remains
unchanged.

## Server Data Flow

The endpoint supports three read modes:

- No cursor: read the newest 100 JSONL records within a 2 MiB page.
- `before=<cursor>`: read up to 100 records and 2 MiB immediately before the
  cursor.
- `after=<cursor>`: read records appended after the cursor for live polling.

Every response includes the byte range it covers:

```json
{
  "agent": "codex",
  "sessionId": "session-1",
  "entries": [],
  "startCursor": "8192",
  "endCursor": "16384",
  "nextCursor": "8192"
}
```

`nextCursor` is present only when older bytes remain. The existing ETag still
represents transcript identity, size, and modification time. An unchanged
poll returns `304`; a changed poll uses `after` so the client receives only
new records.

The range reader scans backward from `before` to locate record boundaries,
stopping when it reaches either limit, then parses only that byte range. A
record larger than the byte limit is skipped across bounded pages instead of
being materialized. Entry IDs in paginated responses are based on absolute
source byte offsets, so they remain stable across page requests. Malformed
records remain skippable.

## Tool Compaction

After parsing a page, consecutive `tool` and `tool_result` entries are
compacted:

- Count only `tool` entries, because each represents one call.
- Discard tool names, arguments, and result content.
- Emit one `tool_group` entry with `toolCalls`.
- Drop result-only fragments at a page boundary.
- Merge adjacent tool groups in the browser when older or newer pages are
  attached.

Thinking and message entries keep their current presentation.

## Browser State and Interaction

The browser keeps one combined transcript plus:

- the cursor for the next older page;
- the byte offset already observed at the live edge;
- a separate loading state for older history.

Opening the tab fetches the newest page and starts at the bottom. Polling asks
for records after the observed live-edge cursor and appends them. `Load more`
requests the next older page and prepends it. The viewport compensates for the
inserted height so the same content remains under the reader after the
prepend. Empty normalized pages retain `Load more` when an older cursor exists,
and in-flight history responses are discarded when the terminal changes.

The `Load more` row appears at the top of the transcript, uses the existing
monospace utility style, and remains visually subordinate to messages.
`tool_group` is a quiet, non-expandable status row such as `1 tool call` or
`5 tool calls`; there is no disclosure control because tool content is not
available.

## Error Handling

- Invalid or negative cursors return `400 invalid_agent_log_cursor`.
- Cursors beyond the current file size are clamped by a reset response using
  the newest page; the browser replaces stale state when the returned range
  does not begin at its requested `after` cursor.
- A failed `Load more` keeps the current log and makes the control available
  for retry.
- Existing missing-link, read-error, and automatic refresh behavior stays
  unchanged.

## Testing

- Go tests cover backward page boundaries, absolute IDs, older cursors,
  appended ranges, invalid cursor handling, and tool compaction.
- React tests cover the initial newest page, compact tool counts, prepending
  older pages, viewport preservation, live append, and disabled loading state.
- API tests cover cursor query construction.
- Playwright creates more than one page of transcript records and verifies
  newest-first opening, the top `Load more` flow, compact tool activity, and
  continued live updates using the isolated E2E database.

## Out of Scope

- Searching, filtering, or exporting logs.
- Expanding compact tool activity.
- Loading arbitrary transcript paths.
- User-configurable page size.
