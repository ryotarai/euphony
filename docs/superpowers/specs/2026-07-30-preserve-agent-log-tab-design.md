# Preserve Agent Log Tab Design

## Goal

Keep a terminal pane's selected source stable when agent lifecycle updates
temporarily remove and then re-add that pane through dynamic status filters.
In particular, a pane showing the agent log must not reset to the terminal when
its agent moves from `running` to `waiting`.

## Root Cause

`TerminalPane` owns its source selection as local React state. Dynamic status
filters intentionally remove panes that no longer match. A focused
`running -> waiting` transition first appears as attention, so a pane selected
by the Running and Waiting filters can be removed before attention is
acknowledged and re-added as Waiting. The remount initializes the local source
to `terminal`.

## Approaches

1. Store each session's selected source in `App` and make `TerminalPane`
   controlled. This preserves the source across transient pane unmounts without
   keeping inactive terminal or log components mounted.
2. Keep filtered-out panes mounted and hide them. This preserves all local
   state but conflicts with dynamic filter semantics and retains unnecessary
   terminal connections and polling components.
3. Persist selected sources in the URL or browser storage. This also survives
   reloads, but reload persistence is outside the reported behavior and adds
   cleanup and compatibility concerns.

Use approach 1.

## Component and Data Flow

- `App` owns a `Record<sessionID, PaneSource>` for pane source selections.
- `TerminalPane` receives the selected source and reports explicit tab changes.
- `TerminalPane` continues to own its terminal fit counter because that state
  only matters while the terminal component is mounted.
- Re-entering a pane within the same App lifetime restores its last explicit
  source. New sessions default to `terminal`.

## Testing

An App integration test selects both Running and Waiting dynamic filters, opens
the first pane's agent log, advances polling through
`running -> attention -> waiting`, and asserts that the re-added pane still has
the Agent log tab active. Existing component and full Web tests must remain
green.

