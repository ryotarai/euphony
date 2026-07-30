# Preserve Agent Log Tab Design

## Goal

Keep a terminal pane's selected source stable when agent lifecycle updates
temporarily remove and then re-add that pane through dynamic status filters.
In particular, a pane showing the agent log must not reset to the terminal when
its agent moves from `running` to `waiting`.

## Root Cause

`TerminalPane` owns its source selection as local React state. Dynamic status
filters intentionally remove panes that no longer match. A focused
`running -> waiting` transition has `agentStatus: "waiting"` and a separate
`needsAttention` flag, but filter matching currently treats attention as an
exclusive replacement status. A pane selected by the Running and Waiting
filters is therefore removed before attention is acknowledged and re-added as
Waiting. The transient removal changes focus and remounts the pane with its
source initialized to `terminal`.

## Approaches

1. Match an attention session against both `attention` and its actual
   `agentStatus` for dynamic filter membership. This models unread attention as
   an overlay, prevents the spurious removal, and leaves intentional status
   changes dynamic.
2. Store each session's selected source and displaced focus in `App`. This can
   restore the view after a remount, but it reacts after the incorrect filter
   removal and introduces extra synchronization state.
3. Keep filtered-out panes mounted and hide them. This preserves all local
   state but conflicts with dynamic filter semantics and retains unnecessary
   terminal connections and polling components.

Use approach 1.

## Filter and Data Flow

- `sessionActivity` remains the primary display activity and may return
  `attention`.
- `matchesWorkspaceFilter` additionally considers `agentStatus` when
  `needsAttention` is true.
- A waiting session with unread attention therefore matches both Attention and
  Waiting status/CWD filters.
- `TerminalPane` remains mounted during the transition, so its selected source,
  terminal connection, and log view state remain unchanged.

## Testing

An App integration test selects both Running and Waiting dynamic filters, opens
the first pane's agent log, advances polling through
`running -> attention -> waiting`, and asserts that the re-added pane still has
the Agent log tab active. A Playwright regression repeats the transition
through the real hook, polling, acknowledge endpoint, and browser UI. Existing
component and full Web tests must remain green.
