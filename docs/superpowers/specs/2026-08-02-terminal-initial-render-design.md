# Terminal Initial Render Recovery Design

## Context

An Euphony terminal can occasionally appear collapsed or stale after its pane
is mounted or its source becomes visible. Resizing the browser window makes the
terminal render normally again. The affected path uses xterm.js with shared
terminal-size negotiation, so the browser must not resize its xterm buffer to
its local capacity independently of the server.

`TerminalView` currently uses `ResizeObserver` and `window.resize` only to
propose a capacity. Once the server accepts a size, xterm is resized and the
accepted grid is measured for centered rendering. If the surrounding pane
layout settles without changing the negotiated columns or rows, no explicit
renderer refresh is requested. A browser window resize can incidentally cause
the missing redraw, which explains why it repairs the display.

## Goals

- Repaint a terminal after its initial or post-tab layout settles.
- Repaint after a host resize even when the negotiated columns and rows stay
  unchanged.
- Preserve shared terminal-size negotiation and centered grid geometry.
- Keep hidden terminal sources measurable and avoid resizing hidden PTYs.
- Add a regression test that fails when the layout observation does not request
  a repaint.

## Non-goals

- Change the shared minimum-size policy or WebSocket protocol.
- Call `fit()` as a substitute for server-accepted terminal sizes.
- Change terminal colors, typography, pane layout, or user interactions.
- Replace xterm.js's WebGL renderer or alter its fallback behavior.

## Approaches considered

1. Call `fit()` for every layout observation. This would mutate the xterm grid
   to the local viewport and can temporarily override the shared PTY geometry,
   so it is rejected.
2. Force a new `resize()` claim for every observation. This still cannot
   distinguish a repaint from a PTY resize and would create unnecessary
   negotiation traffic.
3. Expose xterm's public `refresh()` through `TerminalDriver` and request a
   repaint after accepted sizes and layout observations. This preserves the
   negotiated grid and is the selected approach.

## Design

`TerminalDriver` gains an optional `refresh()` operation. The real xterm
adapter maps it to `terminal.refresh(0, terminal.rows - 1)`, while injected
test drivers can omit it. `TerminalView` invokes the operation only when its
host is visible. The existing `proposeDimensions()` and server `resize()` path
remains responsible for capacity claims and accepted grid changes.

The terminal view requests a repaint when the host is observed, after a
server-accepted resize has updated the grid geometry, after the delayed pane
layout measurement, and when a previously hidden terminal source becomes
visible. The grid geometry state continues to be measured in an animation
frame, so the repaint observes the DOM after the centered-grid styles have
been committed. Cleanup cancels any pending frame and leaves socket and PTY
lifecycle unchanged.

## Error handling and invariants

- A missing optional `refresh()` is ignored for compatibility with test and
  alternate terminal drivers.
- Hidden hosts are never refreshed or resized.
- No browser-side repaint can send a PTY resize.
- Existing accepted-size validation, history buffering, and resize
  deduplication remain unchanged.

## Testing

- Add a TerminalView regression test that fires a host resize observation while
  the capacity is unchanged and asserts that the terminal requests a repaint.
- Keep the existing accepted-size, source-tab, centered-grid, and hidden-host
  tests green.
- Run the complete Vitest suite, TypeScript typecheck, production build, and
  the terminal-focused Playwright suite with an isolated in-memory database.

