# Pane Selection Checkbox Design

## Goal

Put a compact checked checkbox in each pane's existing source rail. Unchecking
it removes that terminal from the workspace selection.

## Interaction

- Every rendered pane shows a checked checkbox because rendered panes are
  selected by definition.
- The control is labelled `Deselect <terminal name>` for assistive technology.
- Unchecking removes the pane and updates the URL selection.
- Removing the focused pane focuses the first remaining pane.
- Removing the last pane leaves the workspace empty and shows the existing
  empty state.
- When a status or cwd filter owns the terminal, deselection uses the same
  filter-release and decomposition behavior as the sidebar terminal checkbox,
  so the filter does not immediately add the pane again.
- Pressing the checkbox does not first focus the pane or switch its source tab.

## Architecture

`TerminalPane` owns the rail markup and receives an `onDeselect` callback from
`App`. `App` extends its existing session-selection operation with an explicit
`allowEmpty` option. The sidebar keeps its current at-least-one-pane behavior,
while the pane checkbox opts into an empty workspace.

The checkbox belongs in `TerminalPane`, rather than `PaneCarousel`, because the
rail is pane-local chrome and already composes the terminal and agent-log
sources. `PaneCarousel` remains concerned only with layout, visibility, and
focus.

## Visual Direction

Preserve the existing 30px black signal rail, monochrome checkbox tokens, Geist
utility text, and flat pane geometry. Place the 14px checkbox at the rail's
right edge beside the source label. This adds one precise selection affordance
without creating another toolbar or changing pane height.

## Testing

- `TerminalPane` component coverage verifies the checked accessible control and
  its deselection callback.
- `App` coverage verifies URL updates, focus transfer, pane removal, and removal
  of the final pane.
- Existing filter-selection tests guard status/cwd decomposition behavior.
- Playwright verifies the real rail control removes a selected split pane.

## Out of Scope

- Selecting an unselected terminal from the pane rail.
- Moving the checkbox into carousel navigation controls.
- Changing sidebar checkbox behavior.
- Persisting a separate pane-enabled state.
