# Terminal WebGL Context-Loss Recovery Design

## Context

Euphony renders terminal sessions with xterm.js and prefers the WebGL addon
when the browser supports it. After a terminal has been used for a while, the
browser can lose the WebGL context. While that context is lost, xterm's WebGL
canvas remains mounted but cannot paint terminal cells, so the terminal area
appears completely black. Resizing the browser can trigger a later redraw or
context recovery, which makes the symptom appear intermittent.

The current adapter listens only to the WebGL addon's public `onContextLoss`
event. In the installed xterm addon version, that event is intentionally
delayed for three seconds while it waits for `webglcontextrestored`. The
terminal can therefore remain black during that delay. A browser-level
`webglcontextlost` event can be observed immediately on the WebGL canvas.

## Evidence

- Existing code loads `WebglAddon` for every normal terminal.
- Existing xterm addon source waits 3,000 ms before firing `onContextLoss`.
- In Chromium, dispatching `webglcontextlost` on the active WebGL canvas
  reproduced a fully black terminal screenshot immediately.
- With the current delayed handler, the DOM renderer returned only after the
  delayed addon disposal.
- Ordinary terminal output and repeated pane changes passed existing tests, so
  this change targets renderer recovery rather than terminal protocol or PTY
  size negotiation.

## Goals

- Recover from a lost WebGL context immediately instead of waiting for the
  addon's delayed notification.
- Keep WebGL rendering unchanged while its context is healthy.
- Let xterm's existing addon disposal path restore its DOM renderer and force a
  full repaint.
- Add unit and browser regression coverage for the black-screen mechanism.
- Preserve terminal sizing, output byte order, pane residency, and visual
  styling.

## Non-goals

- Disable WebGL for all terminals.
- Add a periodic rendering watchdog or change terminal output batching.
- Change shared terminal-size negotiation or PTY dimensions.
- Change the terminal theme, layout, typography, or source-tab behavior.
- Rebuild or replace xterm.js.

## Approaches considered

### 1. Disable WebGL globally

This removes the context-loss failure mode, but increases CPU usage for every
terminal and discards the existing performance optimization. It is not
necessary because xterm already provides a DOM renderer fallback.

### 2. Add a periodic refresh watchdog

This could repaint some compositor glitches, but it cannot reliably detect a
lost WebGL context and would add continuous work even when the terminal is
healthy. It would mask the renderer failure instead of recovering from it.

### 3. Dispose WebGL immediately on the native context-loss event

This preserves WebGL in the normal case and uses xterm's supported addon
disposal path when the browser reports a real context loss. The adapter will
inspect the terminal host after loading the addon, attach a one-shot listener to
the WebGL canvas, and dispose the addon through an idempotent callback. The
existing delayed `onContextLoss` listener remains as a safety net for context
losses that are surfaced only through the addon event.

This is the selected approach.

## Design

`loadWebglRenderer` will accept the xterm terminal element as optional adapter
context. After loading the addon, it will identify host canvases that expose a
WebGL2 context and attach a `webglcontextlost` listener. Both the native event
and the addon's delayed event call the same guarded disposal function, so the
addon is disposed at most once.

Disposing the addon uses xterm's existing `WebglAddon.dispose` behavior. That
behavior restores xterm's default DOM renderer, handles the current terminal
size, and requests a full refresh. The listener is one-shot and is removed when
the fallback begins; terminal unmount cleanup continues to be owned by xterm's
normal terminal disposal.

If no WebGL2 canvas is found, the helper keeps its current success behavior and
the DOM renderer remains available. If addon loading throws, the current
warning and DOM-renderer fallback are unchanged.

## Data flow

Healthy terminal:

`Terminal.open -> WebGL addon load -> WebGL canvas paints`

Context loss:

`webglcontextlost -> guarded addon.dispose -> xterm DOM renderer -> full repaint`

The terminal WebSocket, output batcher, negotiated PTY size, and application
state are unchanged in both paths.

## Error handling and invariants

- A context-loss callback is idempotent; duplicate native and addon events do
  not dispose the addon twice.
- Missing `element`, missing WebGL2 support, or missing context-loss APIs are
  treated as no-op compatibility cases.
- A context loss never sends a resize or resize-release message.
- The active terminal remains mounted and keeps its existing xterm buffer.
- A normal `webglcontextrestored` event before fallback may still be handled by
  xterm's WebGL addon; the immediate fallback is only for a reported loss that
  reaches the adapter.

## Testing

- Add a `TerminalView` unit test with a fake WebGL canvas proving that the addon
  is disposed immediately when the canvas emits `webglcontextlost`.
- Retain the existing delayed `onContextLoss` unit test to prove the safety-net
  path still disposes the addon.
- Add a Playwright terminal-reliability test that emits context loss on the
  active WebGL canvas and asserts that xterm returns to DOM rows without
  waiting three seconds.
- Run the focused Vitest tests, the complete frontend suite, frontend
  typecheck, production build, Go tests, React Doctor changed-scope scan, and
  the isolated terminal Playwright suite.
