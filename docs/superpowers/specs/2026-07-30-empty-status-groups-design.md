# Empty Status Groups Design

## Goal

Keep every built-in terminal activity visible in the left sidebar, even when
that activity currently has no terminal sessions.

## User Experience

The sidebar always renders these activity groups in this order:

1. Blocked
2. Need attention
3. Running
4. Waiting
5. Terminal

Each group keeps its existing checkbox and terminal count. When a group has no
sessions, its count is `0` and its content area contains the text
`No terminal`.

An empty group's checkbox remains interactive. Selecting it records the
existing dynamic status filter, so a session that later enters that activity
is automatically added to the workspace. Clicking an empty group's label does
not replace the current pane selection because there is no pane to focus.

## Architecture

`SessionNavigation` owns the presentation of activity groups. Its
`orderedActivities` helper will start from the built-in activities and append
any unknown activity values reported by sessions. This preserves support for
future or backend-defined activity values while ensuring the four standard
groups are always present.

`SessionList` will render a lightweight empty-state message when an activity
has no working-directory groups. Existing status filter callbacks, URL state,
and dynamic pane reconciliation remain unchanged.

## Visual Direction

This is a restrained extension of the existing dense terminal sidebar. The
empty-state copy uses the sidebar's existing secondary text treatment and
indentation rather than introducing a card, icon, or decorative affordance.
The status checkbox, label, and zero-count badge retain their current layout.

## Testing

A React component test will load sessions representing only one built-in
activity and verify that:

- all five built-in activity headings and checkboxes are present;
- the four empty groups each show `No terminal`;
- the populated group does not show an empty-state message;
- the empty groups display a count of zero through the existing badge.

The focused test must fail before implementation and pass after the minimal
navigation change. The full frontend unit suite, typecheck, and production
build will be run afterward. A focused Playwright test will verify in Chromium
that the empty groups are visible and that selecting an empty status checkbox
persists the status filter without removing an independently selected pane.
