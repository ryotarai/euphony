# Status Filter Grace Period Design

## Problem

The web app recalculates dynamically selected terminal panes immediately after each session snapshot. When a terminal selected by a status or cwd filter changes activity, such as `running` to `waiting`, it no longer matches the filter and disappears on the next poll. Agent lifecycle updates can be transient, so this makes panes flicker or disappear before the status settles.

## Goal

Give a filter-owned terminal a 10-second grace period after a session status event makes it stop matching the active filter. At the end of the period, remove it only if the latest session snapshot still does not match. If it matches again before expiry, cancel the pending removal and keep it selected.

## Scope and non-goals

- Apply the delay to automatic selection changes caused by session status/activity updates.
- Preserve immediate behavior for explicit user operations such as selecting a terminal, changing a filter, pinning, or deleting.
- Keep manually selected and pinned terminals selected regardless of filter membership.
- Do not delay or alter server event delivery; this is a browser selection presentation concern.
- Do not add a new visual treatment. Existing terminal panes remain visible during the grace period.

## Design

The existing session-snapshot path records activity transitions before updating React state. Add a per-terminal pending filter-removal timer registry. The registry is created only when all of the following are true:

1. The terminal was previously owned by the active filter selection.
2. A session snapshot event made it stop matching the current status/cwd filters.
3. The terminal remains selected and is not pinned.

The filter reconciliation effect keeps pending IDs in the selected list while their timers are active. A timer callback records the ID as expired and triggers one reconciliation pass. That pass checks the current `sessions` snapshot; it removes the terminal only when the session still does not match. The callback does not trust the stale snapshot that created the timer.

When a later snapshot shows the terminal matching again, reconciliation clears its timer and keeps it selected. If the terminal is manually deselected, pinned, removed, or the filter is changed, the timer is cleared so explicit user actions remain immediate. Component cleanup clears all pending timers.

The `filterDeselectDelayMs` constant defines the independent 10-second grace period for filter-driven transient status changes.

## Data flow

```text
session snapshot event
  -> record activity transition
  -> update sessions
  -> detect previous filter-owned IDs that no longer match
  -> keep ID selected + start 10s timer
  -> status recovers: cancel timer, keep pane
  -> timer expires: re-read current sessions
       -> still does not match: remove from selection
       -> matches again: keep selected
```

## Error and lifecycle handling

- Timers are browser-local and must be cleared on component unmount.
- A stale timer must never remove a terminal that has become a match again.
- A timer must not keep a terminal selected after a user explicitly removes it or pins it.
- If the terminal disappears from the session list, normal terminal-removal reconciliation remains authoritative.
- Existing shared-selection writes continue to happen only after the delayed automatic removal, not when the transient status first arrives.

## Verification

Add regression coverage to the existing `App.test.tsx` behavior suite using fake timers:

- A status-filtered terminal remains visible before 10 seconds after changing from the filter's status to another status.
- The terminal is removed and the replacement is selected after 10 seconds if the status remains outside the filter.
- Returning to the filtered status before expiry cancels the pending removal and does not remove the terminal.
- Existing immediate explicit filter changes remain passing.
