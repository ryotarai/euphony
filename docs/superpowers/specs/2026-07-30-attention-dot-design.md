# Attention Dot Design

## Goal

Present unread attention as a notification overlay instead of a terminal
lifecycle status, and mark blocked agent sessions as needing attention.

## Behavior

- Sidebar status groups remain lifecycle-based: Blocked, Running, Waiting, and
  Terminal.
- `needsAttention` never changes the status group that contains a session.
- A session with `needsAttention: true` shows a small blue dot immediately
  before its agent icon or title.
- The dot has an accessible `Needs attention` label and is hidden when the flag
  is false.
- A transition from `running` to either `waiting` or `blocked` sets
  `needsAttention`.
- Existing focus acknowledgement continues to clear `needsAttention` without
  changing the lifecycle status.

## Visual Direction

The sidebar stays dense and quiet. Attention uses one new signal color,
`#38bdf8`, on a 6px circular marker. The marker does not pulse, tint the row, or
compete with the existing selected-row treatment. Its placement in the title's
reading path makes it visible without turning attention into another group.

## Compatibility

Existing saved URLs may contain the legacy `attention` filter. The application
may continue parsing that value, but the sidebar and command palette no longer
offer attention as a selectable status.

## Testing

- A component test proves an attention session stays in its actual lifecycle
  group, no Need attention group is rendered, and only flagged sessions expose
  the accessible dot.
- Manager tests prove both `running -> waiting` and `running -> blocked`
  transitions set `needsAttention`.
- Existing acknowledgement tests continue proving that focus clears only the
  unread flag.
- A Playwright check verifies the marker's rendered geometry and color in the
  browser.
