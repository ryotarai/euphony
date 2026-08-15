# New Session Placeholder Design

## Goal

Make sessions with no meaningful purpose or summary recognizable as newly
created sessions by displaying `New session` in the project sidebar and the
session information pane.

## Scope

The placeholder is a presentation fallback. It must not be persisted in
session metadata, agent summaries, API responses, or search indexes.

Use an existing agent title or process name when one is available. Use
`New session` only when the session has no generated purpose, agent title,
process name, or summary text. Keep the existing `No summary yet.` and `No
action required.` copy for the information pane's other empty fields.

## Approaches considered

1. Add the fallback only to the project sidebar. This is the smallest change,
   but the sidebar and detail pane would disagree about the same empty session.
2. Add the fallback in both presentation components. This keeps the display
   consistent without changing the session model or API. This is the selected
   approach.
3. Generate `New session` in the API or state layer. This would make a
   presentation concern part of persisted/domain data and could affect other
   consumers, so it is out of scope.

## Design

`ProjectSidebar` keeps its existing priority order for row text:

1. generated purpose;
2. agent title or process name;
3. latest summary;
4. `New session`.

`SessionInfoPane` keeps its existing identity priority order and changes only
the final purpose fallback to `New session`. Its summary and action fields keep
their current empty-state labels.

No new colors, typography, motion, or layout are needed. The existing purpose
text treatment already provides the correct visual hierarchy for this short
label.

## Testing

Add component tests for a session with no summary, purpose, agent title, or
process name. Assert that both components render `New session`. Keep the
existing tests for generated purposes and summaries to prove the fallback does
not override meaningful content. Run the focused Vitest tests, the frontend
typecheck, the changed-scope React Doctor scan, and the repository's relevant
Go/frontend regression suites.
