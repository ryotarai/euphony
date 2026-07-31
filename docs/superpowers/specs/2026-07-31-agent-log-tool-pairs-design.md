# Expandable Agent Log Tool Pairs Design

## Summary

Make compact Agent Log rows such as `5 tool calls` expandable. The expanded
view presents each tool invocation and its matching result as one readable
execution unit while retaining the bounded transcript paging model.

## Chosen Approach

Three approaches were considered:

1. Fetch tool details from a second endpoint when the row opens. This keeps the
   initial response smallest, but introduces another cursor contract, loading
   states inside the transcript, and races with a growing transcript.
2. Stop compacting tools on the server and regroup raw entries in React. This
   keeps the transport model simple, but makes the compact group an implicit
   browser-only structure and complicates page-boundary merging.
3. Keep `tool_group` as the transport unit and include its bounded normalized
   tool entries. This preserves current paging and merge behavior, opens
   immediately, and gives React enough information to pair calls and results.

Use approach 3. Each page is still limited to 100 JSONL records and 2 MiB of
source data. Individual normalized tool content remains capped at the existing
48 KiB limit.

## Transport Model

Add two optional fields to normalized entries:

```go
type Entry struct {
    // Existing fields omitted.
    CallID  string  `json:"callId,omitempty"`
    Entries []Entry `json:"entries,omitempty"`
}
```

Parsers retain the agent-provided call identifier on both calls and results.
`CompactTools` still replaces consecutive tool activity with one `tool_group`,
but the group now keeps the normalized child entries in source order instead
of dropping them.

Result-only fragments at a page boundary are preserved in a group with no
`toolCalls` value. When an older or appended page is joined to the current
transcript, adjacent groups merge their child entries. This allows a call and
result split across page requests to become a pair in the browser.

No browser-supplied path or new transcript lookup is introduced.

## Browser Pairing and Interaction

`AgentLogView` derives executions from the child entries:

- A `tool` entry starts an execution.
- A `tool_result` with the same `callId` attaches to that execution.
- An unmatched result becomes a result-only execution so page fragments remain
  visible rather than disappearing.
- Source order is retained for both matched and unmatched entries.

The group uses native `<details>` and `<summary>` semantics. It is collapsed by
default, opens by mouse or keyboard, and keeps the existing count and timestamp
in the summary. Expanded content is present only inside that disclosure.

Each execution has one tool-name header followed by two explicitly labeled
regions:

```text
›  01  exec_command                                      03:00:00
   CALL
   {"command":"go test ./..."}
   │
   RESULT
   ok
```

If a result has not arrived, the result region reads `Waiting for result…`.
Tool content remains plain preformatted text; it is never treated as HTML.

## Visual Direction

The subject remains Euphony's local operator console for developers supervising
coding agents. This change must feel like inspecting an instrument trace, not
opening a collection of generic cards.

Palette:

- Console black `#050505`
- Raised trace `#111111`
- Hairline `#262626`
- Primary text `#F5F5F5`
- Instrument gray `#8F8F8F`
- Focus signal `#B8F34A`

Typography keeps the existing Geist/Avenir prose stack and the existing
`SFMono-Regular` utility stack for counts, labels, tool names, and payloads.

The signature element is a single quiet vertical trace linking `CALL` to
`RESULT` inside each execution. Real sequence numbers identify invocation
order. Borders and spacing, rather than rounded cards or decorative color,
separate executions. The only motion is the existing 120 ms disclosure chevron
rotation, and reduced-motion users receive no transition.

This direction deliberately reuses Euphony's established console palette
instead of introducing a new accent or surface system. The distinctive change
is structural: tool data reads as a connected execution trace.

## Error and Boundary Behavior

- Empty input or output renders as `(empty)`.
- A call without a result shows `Waiting for result…`.
- A result without a visible call uses its result title or `Tool result`.
- Adjacent groups merged during older-page prepend or live append also merge
  their child entries.
- Existing polling, ETag, scroll-follow, viewport compensation, and transcript
  replacement behavior remains unchanged.

## Testing

- Go parser tests assert that Claude and Codex calls/results retain `callId`.
- Go compaction tests assert that a group counts calls, preserves payloads and
  results, and retains result-only page fragments.
- React tests click the count row, assert details are initially hidden, and
  verify matching calls and results share an execution container.
- React paging tests assert merged groups also merge child details.
- Playwright opens a real paginated Agent Log, expands `3 tool calls`, and
  verifies call and result content is paired and visible.

## Out of Scope

- Searching, filtering, copying, rerunning, or approving tool calls.
- A second lazy-loading endpoint for tool detail.
- User-configurable tool payload limits.
- Changes to general message, reasoning, or Markdown rendering.
