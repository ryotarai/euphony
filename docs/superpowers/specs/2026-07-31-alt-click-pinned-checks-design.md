# Alt-Click Pinned Checks Design

## Goal

Use Alt-click (Option-click on macOS) instead of Shift-click to pin terminal,
status, and working-directory checkboxes in the sidebar.

## Interaction

- A plain click keeps the existing checkbox selection behavior.
- A Shift-click also keeps the existing checkbox selection behavior.
- An Alt-click selects and pins an unpinned checkbox.
- Clicking a pinned checkbox directly removes its pin using the existing
  removal behavior.
- The unpinned checkbox tooltip says `Option-click to pin`, matching the
  product's macOS interface language.

## Implementation

`SessionNavigation` is the only component that interprets the mouse modifier.
Its terminal, status, and cwd checkbox handlers will forward a pin request
when `MouseEvent.altKey` is true. No selection state or persistence behavior
changes are required in `App`.

The existing amber pinned state, direct-removal tooltip, URL state, and server
selection persistence remain unchanged.

## Verification

- Component tests prove Alt-click forwards a pin request for all three
  checkbox levels and Shift-click does not.
- App integration tests use Alt-click for pinning scenarios.
- Playwright exercises terminal, status, and cwd pinning with the Alt
  modifier against the built application.
- Type checking and the relevant test suites must pass.
