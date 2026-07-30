# Pinned Terminal Checkboxes Design

## Goal

Allow a terminal pane to remain selected when other terminals or dynamic
filters are selected. A user pins a terminal by Shift-clicking its unchecked
sidebar checkbox and removes the pin only by clicking that checkbox again.

## Interaction

- Clicking an unselected terminal checkbox keeps the existing multi-select
  behavior.
- Shift-clicking an unselected terminal checkbox selects and pins that
  terminal.
- Shift-clicking a selected but unpinned terminal checkbox pins it without
  deselecting it.
- Clicking a pinned terminal checkbox directly removes both its pin and its
  selection, including when it is the last selected pane.
- Clicking a terminal row, selecting a status or directory, changing a dynamic
  filter, creating a terminal, or following a newly identified agent preserves
  every pinned terminal.
- Deleting a pinned terminal removes its pin.
- Pin state is encoded with repeated `pin` URL parameters, alongside the
  existing repeated `terminal` parameters, so reload and browser navigation
  restore the same workspace.

## Architecture

`App` owns `pinnedIDs` as workspace state. `pinnedIDs` is always a subset of
the available selected session IDs. Workspace replacement operations merge
their ordinary result with available pinned IDs before updating selection,
focus, and the URL. Dynamic-filter ownership never claims a pinned ID, so
removing a filter cannot remove a pinned pane.

`SessionNavigation` receives `pinnedIDs` and reports a checkbox interaction
with its Shift modifier. It renders pinned checkbox state through a
`data-pinned` attribute and a small `PinIcon` that does not replace the
checkbox's checked indicator. The existing selection label remains stable for
assistive technology, while a title explains the Shift-click gesture and the
direct removal action.

## Visual Direction

The existing sidebar is dense, monochrome terminal chrome. Pinned state uses a
single amber accent (`#f59e0b`) on the checkbox border and a compact pin glyph;
all surrounding layout, typography, and checked-state contrast remain
unchanged. This makes persistence visible without adding another toolbar or
decorative component.

## Error and Edge Cases

- URL pin IDs that do not identify a current session are ignored.
- URL pin IDs are restored into selection even if a malformed URL omits the
  corresponding `terminal` parameter.
- A deleted or no-longer-available session is removed from pin state.
- Direct removal of the focused pinned pane moves focus to the first remaining
  pane, or clears focus for an empty workspace.

## Verification

- Component tests verify Shift modifier forwarding and the pinned visual state.
- App tests verify pin creation, preservation across replacement selection,
  direct removal, and URL restoration.
- Playwright verifies the user-visible Shift-click flow against the running
  application.
- The complete unit test suite, typecheck, and production build must pass.
