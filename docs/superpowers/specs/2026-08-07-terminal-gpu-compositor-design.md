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
status semantics, and the existing WebGL-to-DOM fallback.

## Non-goals

- Do not remove the WebGL renderer.
- Do not drop terminal output or parse/drop intermediate ANSI frames.
- Do not change terminal selection, pane residency, source tabs, or keyboard
  behavior.
- Do not announce status transitions through a new live region.

## Considered approaches

1. Remove WebGL entirely. This would reduce GPU work but regresses the
   existing renderer performance improvement and increases DOM layout work.
2. Keep WebGL and only remove the running spinner. This fixes the continuous
   page compositor loop but leaves high-rate terminal surface submissions.
3. Keep WebGL, make its surface opaque, coalesce live output for at most one
   write every 50ms, and make the running indicator static. This preserves the
   renderer and terminal bytes while addressing both trace signatures. This is
   the selected approach.

## Design

### Live terminal output scheduler

Add a small, dependency-free scheduler that accepts `Uint8Array` chunks,
queues them for at most 50ms, concatenates all queued chunks in arrival order,
and calls xterm's `write` once. It exposes `flush` and `dispose`; disposal
flushes pending data before the terminal is disposed. Empty chunks are ignored.

Only live output after the first accepted terminal size uses this scheduler.
History replay, the initial pre-size queue, error text, and exit text keep their
existing immediate ordering behavior. The scheduler delays visual display by
at most 50ms but never discards bytes.

### Opaque WebGL surface

Set xterm's `allowTransparency` option to `false`. Euphony's terminal host and
theme already use an opaque `#050505` background, so this changes composition
mode without changing the visible terminal.

### Running status indicator

Keep the `LoaderCircleIcon`, class name, color, `role="img"`, accessible
`Running` label, and row ordering. Remove only the infinite rotation so the
status remains visually distinct without forcing a display frame forever.

## Testing

- Unit-test the output scheduler's batching, byte preservation, empty-chunk
  handling, and disposal flush.
- Assert terminal options are opaque.
- Keep existing SessionNavigation assertions for the running class and
  accessible label; add a CSS contract test that the running selector has no
  animation and that the old infinite keyframe is absent.
- Run focused Vitest tests, the full web suite, typecheck, production build,
  React Doctor, and the terminal Playwright suite when the local server is
  available.

## Acceptance criteria

1. Live output remains byte-for-byte ordered after batching.
2. No terminal output is lost when a terminal view is disposed.
3. xterm is configured with an opaque surface.
4. `running` status no longer has an infinite CSS animation.
5. Existing terminal and status behavior tests remain green.
