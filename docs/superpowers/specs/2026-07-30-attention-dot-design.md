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
- The dot is decorative, while its terminal selection button has the accessible
  description `Needs attention`. Both are hidden when the flag is false.
- A selected pane also shows the same dot immediately before the source label
  in its top rail. The rail indicator exposes a `Needs attention` status to
  assistive technology and disappears with the same flag.
- A transition from `running` to `waiting`, or from any non-blocked status to
  `blocked`, sets `needsAttention`.
- Repeated blocked updates do not restore attention after acknowledgement.
- Existing focus acknowledgement continues to clear `needsAttention` without
  changing the lifecycle status.

## Visual Direction

The sidebar and pane rails stay dense and quiet. Attention uses one signal
color, `#38bdf8`, on a 6px circular marker. The marker does not pulse, tint its
container, or compete with the existing selection treatment. In the sidebar it
sits in the title's reading path; in a pane rail it sits immediately before the
current source label.

## Compatibility

Existing saved URLs may contain the legacy `attention` filter. The application
may continue parsing that value, but the sidebar and command palette no longer
offer attention as a selectable status.

## Testing

- A component test proves an attention session stays in its actual lifecycle
  group, no Need attention group is rendered, and only flagged sessions expose
  the accessible dot.
- A pane component test proves the rail exposes the indicator and accessible
  status only while `needsAttention` is true.
- Manager tests prove both `running -> waiting` and `running -> blocked`
  transitions set `needsAttention`.
- Existing acknowledgement tests continue proving that focus clears only the
  unread flag.
- A Playwright check verifies both marker locations have the same rendered
  geometry and color in the browser.
