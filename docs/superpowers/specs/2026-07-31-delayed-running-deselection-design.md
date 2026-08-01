# Delayed Running-Agent Deselection

## Goal

When the automatic running-agent deselection setting is enabled, keep a
selected terminal visible for ten seconds after its agent changes to
`running`. Show an English toast with a cancel action during that window. If
the user does not cancel, remove the terminal from the selection after the
ten-second delay.

## User experience

- The existing automatic deselection setting remains enabled by default.
- A selected, non-pinned terminal that transitions to `running` shows a toast:
  `"<terminal name> is now running. It will be removed in 10 seconds."`
- The toast includes a `Cancel` button. Canceling removes the toast and keeps
  the terminal selected.
- If the terminal is manually deselected, becomes non-running, becomes pinned,
  or the setting is disabled before the deadline, its pending removal is
  canceled automatically.
- Pinned terminals keep their existing behavior and never receive this toast.
- Multiple terminals can have independent pending removals, rendered as a
  compact stack in the terminal stage.

## Implementation

The existing running-transition detection remains the source of truth. The
selection effect schedules one ten-second browser timer per eligible terminal
and stores a notice for rendering. Timer expiry queues the terminal ID for the
existing selection mutation path, which removes the ID only if the terminal is
still selected, non-pinned, and currently running. Canceling clears the timer
and notice without changing selection.

The toast uses the existing dark terminal palette, a lime status accent, a
visible keyboard-focusable `Cancel` button, and a polite live region. Timers
are cleared on cancellation, invalidation, and component unmount.

When shared selection is driven by a dynamic status or cwd filter, a running
transition can make the server's next selection snapshot omit the terminal
before the local ten-second timer is visible. While the timer is active, the
client temporarily preserves that terminal as a manual selection and carries
it through subsequent filter recomputation. Timer expiry still uses the
existing selection mutation path, so the temporary selection is removed after
the delay without requiring a backend change.

## Verification

React tests cover the ten-second boundary, cancellation, preservation of the
existing pinned-terminal behavior, and filtered Codex terminals with and
without shared selection. Type checking, production build, the full web unit
suite, and the focused Playwright flow verify the browser behavior.
