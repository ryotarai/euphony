# Shared Terminal Size Design

## Context

Euphony allows multiple browsers to attach to one PTY. Each browser currently
fits its own xterm instance and sends the resulting columns and rows directly
to the PTY. The most recent resize therefore wins, even when another connected
browser cannot display that size. Full-screen terminal applications wrap and
redraw against one geometry while other browsers render with another.

The desired negotiation matches tmux: the PTY uses the smallest capacity
reported by any attached interactive browser. Unlike tmux, larger browser
viewports center the shared terminal grid in quiet, unmarked letterbox space.

## Requirements

- Track terminal capacity independently for every interactive browser
  connection.
- Resize the PTY to the minimum reported columns and minimum reported rows.
- Broadcast the resulting shared size to every participating browser.
- Recompute the shared size when a browser changes capacity or disconnects.
- Keep the last PTY size when no browser remains connected.
- Exclude read-only automation streams and connections that have not reported a
  size.
- Center the shared grid at its native scale in larger browser viewports.
- Retain the capacity claim while switching an in-pane Terminal, Agent Log, or
  Annotation source so source navigation cannot resize the PTY.
- Preserve the existing terminal palette, typography, input, history, and
  reconnect behavior.

## Architecture

### Server-side size coordination

A focused `terminalSizeCoordinator` owned by `Server` stores size claims by
terminal ID and connection ID. Reporting a valid claim or removing a claimed
connection recomputes the component-wise minimum. When that minimum changes,
the session's PTY event loop drains a bounded batch of readable output, resizes
the PTY, and appends the accepted resize event to each connected interactive
client's output queue before reading again. One actor therefore preserves the
causal order pre-resize output, accepted resize, then post-resize output without
holding the terminal input lock.

Each terminal WebSocket subscribes to one ordered terminal-event queue. The
existing single writer goroutine serializes history, output, exit, and accepted
resize messages, so the WebSocket never gains a competing writer or a
cross-channel selection race. The resize message has this browser protocol
shape:

```json
{ "type": "resize", "cols": 100, "rows": 32 }
```

Invalid claims continue to count toward the existing invalid-message policy.
If applying a new minimum fails, the failed claim and accepted size are rolled
back without publishing the tentative size. A `resize_release` message
temporarily removes a browser's claim from minimum calculation without
disconnecting it when its terminal capacity is no longer available. Switching
an in-pane source does not release the claim. Released browsers continue
receiving accepted resize events, so their buffers remain valid while hidden.

### Browser capacity and accepted size

The browser stops treating the xterm buffer size as its available capacity.
Instead, `FitAddon.proposeDimensions()` measures capacity without mutating the
xterm grid. ResizeObserver, window resize, pane topology changes, and WebSocket
open report the latest proposed capacity.

Only an accepted server resize calls `Terminal.resize(cols, rows)`. This avoids
feeding the shared size back as a new local claim and ensures every browser
renders terminal bytes using the PTY geometry.

History and live-output bytes received before the first accepted resize remain
in one FIFO queue. They are written only after xterm applies that size,
preserving both byte order and wrapping/cursor addressing against the
negotiated grid. The server sends a rendering-size baseline before history,
including when the browser starts hidden. A defensive two-megabyte browser
queue closes a connection that never receives a valid baseline instead of
growing without limit.

### Centered browser letterboxing

`TerminalView` records the local capacity and accepted shared size. After an
accepted resize, it measures the rendered `.xterm-screen` and centers the
entire xterm root at that native pixel size. The surrounding space remains the
existing terminal black with no dots, border, scaling, label, or animation.
When the accepted size equals local capacity, xterm fills the host normally.

## Error Handling

- Capacities outside 1 through 1000 columns or rows are rejected before they
  enter coordination.
- A terminal whose capacity is unavailable releases its previous claim instead
  of reporting zero or retaining stale capacity; hiding only its in-pane source
  retains the last measured claim.
- A malformed or unknown server resize is ignored.
- Disconnect cleanup is idempotent.
- If the PTY cannot be resized after a disconnect, the previous accepted size
  remains authoritative for the remaining clients.

## Testing

- Go unit tests cover minimum selection, unchanged minima, invalid claims,
  release/rejoin, output/resize causal ordering, and growth after disconnect.
- Server WebSocket tests cover two browser connections receiving the same
  accepted minimum.
- Vitest covers capacity reporting, accepted resize application, prevention of
  resize feedback, history-before-resize buffering, unavailable-capacity
  release, in-pane source retention, and centered letterbox geometry.
- Playwright opens the same terminal in differently sized browser pages,
  verifies a common accepted grid centered in the larger page, then closes the
  smaller page and verifies expansion to the full viewport.
- The full Go, Vitest, TypeScript, production build, and Playwright suites run
  before completion.

## Assumptions

The user's tmux comparison specifies the negotiation policy. Follow-up feedback
replaces tmux's dotted filler with browser-native centered letterboxing.
Project instructions explicitly require continuing through implementation
without pausing for design approval.
