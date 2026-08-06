# Terminal GPU Compositor Design

## Problem

Opening a running Codex terminal in Euphony increases macOS WindowServer GPU
usage. The supplied Chrome trace shows two independent render loops:

- The terminal WebSocket receives output at roughly 29 messages per second.
  Every output path reaches xterm's `Terminal.refresh` and
  `DrawingBuffer::prepareMailbox`, so the WebGL terminal surface is submitted
  repeatedly.
- The running status icon uses an infinite 900ms CSS rotation. The renderer
  records roughly one `PageAnimator`, `Commit`, `Layerize`, and `PrePaint`
  sequence per display frame.

The terminal background is already opaque, but xterm is configured with
`allowTransparency: true`, which makes each WebGL update eligible for alpha
compositing.

## Goal

Reduce unnecessary WindowServer and browser compositor work while preserving
terminal byte order, terminal input, history replay, resize negotiation,
status semantics, and xterm's DOM renderer behavior.

## Non-goals

- Do not drop terminal output or parse/drop intermediate ANSI frames.
- Do not change terminal selection, pane residency, source tabs, or keyboard
  behavior.
- Do not announce status transitions through a new live region.

## Considered approaches

1. Keep WebGL and only remove the running spinner. This fixes the continuous
   page compositor loop but leaves high-rate terminal surface submissions.
2. Keep WebGL, make its surface opaque, and coalesce live output. xterm already
   schedules writes through its own animation frame, so this adds latency and
   complexity without removing the WebGL mailbox work seen in the trace.
3. Remove the WebGL addon, keep xterm's DOM renderer, and make the running
   indicator static. This removes the terminal's GPU surface submissions and
   the independent page animation while preserving terminal bytes and DOM
   fallback behavior. This is the selected approach.

## Design

### DOM terminal renderer

Do not load `@xterm/addon-webgl` after `Terminal.open()`. xterm's built-in DOM
renderer remains active for every terminal, so output continues through the
same `terminal.write` path without adding an application-level delay or
dropping bytes. Remove the unused addon dependency and its loader tests.

### Opaque terminal surface

Set xterm's `allowTransparency` option to `false`. Euphony's terminal host and
theme already use an opaque `#050505` background, so this changes composition
mode without changing the visible terminal.

### Running status indicator

Keep the `LoaderCircleIcon`, class name, color, `role="img"`, accessible
`Running` label, and row ordering. Remove only the infinite rotation so the
status remains visually distinct without forcing a display frame forever.

## Testing

- Assert terminal options are opaque.
- Keep existing SessionNavigation assertions for the running class and
  accessible label; add a CSS contract test that the running selector has no
  animation and that the old infinite keyframe is absent.
- Remove the WebGL-specific unit tests and dependency, then run focused Vitest
  tests, the full web suite, typecheck, production build, React Doctor, and the
  terminal Playwright suite when the local server is available.

## Acceptance criteria

1. The normal terminal path does not create a WebGL renderer or mailbox.
2. Live output remains byte-for-byte ordered through the existing write path.
3. xterm is configured with an opaque surface.
4. `running` status no longer has an infinite CSS animation.
5. Existing terminal and status behavior tests remain green.
