# Pinned Filter Checkboxes Design

## Goal

Extend Shift-click pinning from terminal checkboxes to status and cwd
checkboxes. A pinned status or cwd remains an active dynamic filter when
ordinary workspace replacement actions occur. Show every pinned checkbox with
an amber fill and no separate pin icon.

## Chosen Approach

Persist pinned status and cwd filters as first-class shared selection state.
This preserves the defining behavior of a dynamic filter: terminals join and
leave the workspace as their status or cwd changes. The alternatives were to
pin only the terminals currently in a group, which would become stale as
sessions change, or to keep filter pins only in browser URL state, which would
break the server-wide selection contract.

## Interaction

- Shift-clicking an unchecked terminal, status, or cwd checkbox selects and
  pins it.
- Shift-clicking a checked but unpinned checkbox pins it without deselecting
  it.
- Clicking a pinned checkbox directly removes both its pin and its selection
  source.
- Pinned status and cwd filters survive terminal-row selection, status/cwd
  label selection, terminal creation with replacement selection, and focused
  terminal promotion into an agent session.
- A pinned status makes its checked child cwd controls appear pinned.
- Unchecking one cwd under a pinned status decomposes the parent into pinned
  cwd filters for the remaining directories.
- Rechecking every cwd that came from a pinned parent consolidates the children
  back into the pinned status.
- Unchecking a terminal governed by a pinned group decomposes or releases the
  pinned group exactly as the existing unpinned filter behavior does.
- Browser history and reload restore terminal, status, and cwd pins.

## Shared Selection Model

`selection.State` and `selection.Snapshot` gain `PinnedFilters`, using the
existing `Filters` shape. Pinned filters are always normalized as a subset of
active filters. A pinned status subsumes pinned cwd filters for that status.
The reducer preserves pinned filters across replacement actions and removes or
decomposes them only through direct deselection.

SQLite stores pinned statuses and pinned cwd filters in dedicated JSON columns.
The v1 selection GET/PUT contract and the TypeScript client expose
`pinnedFilters`. Missing fields remain compatible with older clients and
stored rows by normalizing to empty arrays.

The browser URL uses repeated `pin-status` and `pin-cwd` parameters. `App`
includes pinned filters in selection signatures and write requests so browser
and CLI/server mutations converge on the same state.

## Frontend Structure

`SessionNavigation` receives pinned status and cwd filter arrays. It forwards
the Shift modifier from all three checkbox levels and derives inherited cwd
pin state from a pinned parent status.

`App` owns the two pinned-filter arrays alongside existing active filters.
Filter update functions accept an optional pin intent, maintain the pinned
subset during parent/child decomposition, and merge pinned filters into every
workspace replacement.

## Visual Direction

Keep Euphony's dense black terminal chrome unchanged. Amber `#f59e0b` is the
only pin signal: a pinned checked or indeterminate checkbox uses an amber
background and border with a near-black check mark. Remove `PinIcon` and its
layout styles. Keyboard focus remains visible around the amber control.

## Error and Edge Cases

- An empty status may be pinned and later selects matching terminals.
- Invalid or duplicate URL filters are normalized by existing validation.
- Deleting terminals does not remove pinned dynamic filters; an empty pinned
  filter remains ready for future matching terminals.
- A pinned cwd remains scoped to its status and exact cwd.
- Existing selection rows without pinned-filter columns migrate to empty
  pinned filters.

## Verification

- Reducer and persistence tests cover normalization, preservation,
  decomposition, and round-trip storage.
- API and CLI transport tests cover `pinnedFilters` in complete selection
  replacement.
- Component tests cover Shift forwarding, inherited pin state, amber data
  attributes, and removal of the icon.
- App tests cover status/cwd pinning, replacement preservation, URL state, and
  parent/child decomposition.
- Playwright verifies real Shift-click behavior and computed amber checkbox
  styling.
- Full Go tests, web tests, typecheck, build, and one-worker end-to-end tests
  must pass.
