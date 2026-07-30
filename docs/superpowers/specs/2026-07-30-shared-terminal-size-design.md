# Shared Terminal Size Design

## Context

Euphony allows multiple browsers to attach to one PTY. Each browser currently
fits its own xterm instance and sends the resulting columns and rows directly
to the PTY. The most recent resize therefore wins, even when another connected
browser cannot display that size. Full-screen terminal applications wrap and
redraw against one geometry while other browsers render with another.

The desired behavior matches tmux: the PTY uses the smallest capacity reported
by any attached interactive browser, and larger browsers show a dotted unused
area outside that shared grid.

## Requirements

- Track terminal capacity independently for every interactive browser
  connection.
- Resize the PTY to the minimum reported columns and minimum reported rows.
- Broadcast the resulting shared size to every participating browser.
- Recompute the shared size when a browser changes capacity or disconnects.
- Keep the last PTY size when no browser remains connected.
- Exclude read-only automation streams and connections that have not reported a
  size.
- Render unused cells on the right and bottom of larger browser viewports with
  a middle-dot pattern aligned to the terminal cell grid.
- Preserve the existing terminal palette, typography, input, history, and
  reconnect behavior.

## Architecture

### Server-side size coordination

A focused `terminalSizeCoordinator` owned by `Server` stores size claims by
terminal ID and connection ID. Reporting a valid claim or removing a claimed
connection recomputes the component-wise minimum. When that minimum changes,
the coordinator resizes the PTY once and publishes the accepted size to all
claimed connections for that terminal.

Each terminal WebSocket subscribes to a buffered accepted-size channel. The
existing single writer goroutine serializes history, output, exit, and accepted
resize messages, so the WebSocket never gains a competing writer. The resize
message has this browser protocol shape:

```json
{ "type": "resize", "cols": 100, "rows": 32 }
```

Invalid claims continue to count toward the existing invalid-message policy.
If applying a new minimum fails, the failed claim is rolled back and no
accepted size is published.

### Browser capacity and accepted size

The browser stops treating the xterm buffer size as its available capacity.
Instead, `FitAddon.proposeDimensions()` measures capacity without mutating the
xterm grid. ResizeObserver, window resize, pane topology changes, and WebSocket
open report the latest proposed capacity.

Only an accepted server resize calls `Terminal.resize(cols, rows)`. This avoids
feeding the shared size back as a new local claim and ensures every browser
renders terminal bytes using the PTY geometry.

### Dotted unused area

`TerminalView` records the local capacity and accepted shared size. After an
accepted resize, it measures the rendered `.xterm-screen` and places two
pointer-transparent overlays above only the unused regions:

- a right strip alongside the accepted rows;
- a bottom strip across the available width.

Each overlay uses a repeating radial gradient with one light middle-dot-sized
mark per terminal cell. No label, animation, border, or new interaction is
introduced. When the accepted size equals local capacity, the overlays are not
rendered.

## Error Handling

- Capacities outside 1 through 1000 columns or rows are rejected before they
  enter coordination.
- A hidden terminal does not report a zero or stale capacity.
- A malformed or unknown server resize is ignored.
- Disconnect cleanup is idempotent.
- If the PTY cannot be resized after a disconnect, the previous accepted size
  remains authoritative for the remaining clients.

## Testing

- Go unit tests cover minimum selection, unchanged minima, invalid claims, and
  growth after disconnect.
- Server WebSocket tests cover two browser connections receiving the same
  accepted minimum.
- Vitest covers capacity reporting, accepted resize application, prevention of
  resize feedback, dotted-padding geometry, and growth after a server update.
- Playwright opens the same terminal in differently sized browser pages,
  verifies a common accepted grid and dotted padding in the larger page, then
  closes the smaller page and verifies expansion.
- The full Go, Vitest, TypeScript, production build, and Playwright suites run
  before completion.

## Assumptions

The user's tmux comparison fully specifies the negotiation policy and dotted
visual treatment. Project instructions explicitly require continuing through
implementation without pausing for design approval, so this design proceeds
without an intermediate approval gate.
