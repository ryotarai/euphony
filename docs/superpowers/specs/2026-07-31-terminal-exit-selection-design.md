# Terminal Exit Selection Design

## Goal

When the focused terminal process exits and its session disappears from the
workspace, Euphony should continue showing a surviving terminal instead of
falling into the empty `No signal yet.` state.

## User-visible behavior

- If the focused terminal was the only selected terminal and there are no
  active status or working-directory filters, select the next terminal in the
  sidebar order. If the exited terminal was last, select the previous one.
- If other selected terminals remain, preserve those panes and keep the
  existing focus when it is still available. Existing pinned terminals and
  dynamic filters remain unchanged.
- If a filter is active but no terminal still matches it, do not select an
  unrelated terminal just to avoid an empty state.
- An explicitly empty workspace remains empty. Deselecting the final pane via
  its checkbox must still show `No signal yet.`.
- If no terminal survives the exit, retain the existing empty state.

The replacement is based on the stable sidebar/session creation order: the
successor is preferred because it keeps the user's position moving forward;
the predecessor is the natural fallback for a terminal at the end of the
list.

## Architecture

The backend remains authoritative for shared selection. The selection domain
will gain a reconciliation path for a deleted focused terminal. It only adds
one surviving terminal as a new ordinary manual selection when the previous
snapshot contained exactly the deleted terminal and no filters were active.
The control service chooses the successor/predecessor from the ordered
session metadata and persists/publishes the repaired selection with the
existing `selection.changed` event.

The browser keeps the same rule for the non-shared URL-selection mode and for
explicit local deletion. A small App helper maps the removed terminal's old
sidebar index into the remaining list. Shared mode continues to consume the
server snapshot, so browser tabs converge on the same replacement.

## Data flow

1. The session manager emits `ChangeDeleted` when the shell exits.
2. The control service reconciles stale IDs, detects the focused-only exit,
   chooses the adjacent surviving session, and saves the repaired selection.
3. The service publishes the normal terminal deletion and selection change
   events.
4. The browser refreshes sessions and selection; `PaneCarousel` receives a
   valid focused pane and never renders the empty state for this transition.
5. In non-shared mode, polling/local deletion applies the same adjacency rule
   before writing the URL.

## Error and edge handling

- No replacement ID is added when the session list is empty.
- Dynamic filters are never bypassed by the fallback.
- A stale or missing focus is repaired only when the removed ID was actually
  the sole selected terminal; intentional empty selection is not inferred as
  an exit.
- Existing API errors continue through the current workspace alert path.

## Testing

- Selection tests prove deletion reconciliation selects a successor, selects a
  predecessor when the deleted terminal was last, and leaves an intentional
  empty selection untouched.
- Control tests exercise the real ordered session lifecycle and verify the
  persisted/published focus after deletion.
- App tests prove non-shared polling follows the adjacent surviving terminal,
  while the existing final-pane deselection test continues to prove the empty
  state.
- The full Go test suite, Web Vitest suite, Web typecheck/build, and a
  Playwright smoke check are run before completion.

## Visual direction

No visual redesign is needed. Preserve the existing terminal stage, pane
carousel, sidebar, typography, and empty-state copy; this feature changes only
selection continuity during a lifecycle transition.
