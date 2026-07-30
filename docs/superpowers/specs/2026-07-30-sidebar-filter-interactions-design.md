# Sidebar Filter Interactions Design

## Goal

Make the `status > cwd > terminal` hierarchy visually explicit and make every
level's selection behavior predictable.

## Interaction Model

- A status checkbox is a persistent dynamic filter for every terminal with that
  status.
- While a status filter is active, every cwd checkbox below it is rendered as
  checked.
- Unchecking one cwd under a checked status replaces the status filter with
  dynamic filters for the remaining cwd groups. The status checkbox becomes
  indeterminate.
- Clicking a cwd label replaces the current workspace with one dynamic
  `status × cwd` filter, matching the existing status-label behavior.
- Unchecking a terminal removes any status or cwd filter that would immediately
  re-add that terminal. Other selected terminals stay selected, and unaffected
  cwd filters remain dynamic.
- Checking every cwd in a status consolidates the child filters back into the
  status filter so newly discovered cwd groups also join automatically.

## Visual Hierarchy

The existing neutral black palette and shadcn Sidebar composition remain
unchanged. Cwd rows stay one level below status rows. Terminal menus receive
one additional indentation level, including their selection rule, checkbox,
label, and delete action.

## Settings Dialog

Settings uses the existing shadcn `Dialog`, `Input`, and `Button` primitives.
It shares the same black semantic tokens, radius, spacing, focus trap, Escape
behavior, and footer treatment as the New Terminal dialog.

## Verification

Component tests cover hierarchy, cwd label activation, inherited checkbox
state, and callbacks. App tests cover filter decomposition, terminal
deselection, URL persistence, and Settings dialog composition. Playwright
verifies indentation and the complete status/cwd/terminal interaction in a
real browser.
