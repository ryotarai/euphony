# WindowServer Scrollbar Performance Design

## Goal

Reduce unnecessary macOS WindowServer and browser compositor work while a
terminal is receiving output, without changing terminal bytes, input,
history, resize negotiation, renderer choice, or pane behavior.

## Evidence

The supplied Chrome trace (`Trace-20260810T003913.json`) covers about 14.3
seconds and contains 438 compositor submissions. Every sampled
`PipelineReporter` frame has `has_compositor_animation: true`. The only
application animation events in the trace are xterm scrollbar opacity
transitions on `DIV class='visible scrollbar vertical'` and
`DIV class='invisible scrollbar vertical fade'`. The latter is configured by
xterm.js with an 800ms `opacity` transition and is restarted as terminal output
scrolls the viewport.

The main-thread JavaScript work is not the dominant signal: App callbacks at
the traced source line total about 4ms, while the recurring xterm scrollbar
animation drives compositor frame scheduling between output batches.

## Considered approaches

1. Keep the current xterm renderer and disable only the scrollbar opacity
   transitions inside `.terminal-host` (recommended). This directly removes
   the traced compositor animation while keeping scrollbar affordances and all
   terminal behavior.
2. Remove the xterm WebGL addon. This may reduce GPU mailbox work but changes
   the renderer architecture, increases DOM rendering work, and has already
   been explored in an earlier branch; it is broader than the trace requires.
3. Add more application-level terminal output delay or dropping/coalescing.
   This changes perceived output latency and does not remove the CSS animation
   itself; it is rejected.

## Design

Add a terminal-scoped CSS override after xterm's stylesheet:

```css
.terminal-host .xterm .xterm-scrollable-element > .visible,
.terminal-host .xterm .xterm-scrollable-element > .invisible.fade {
  transition: none;
}
```

The selector is deliberately scoped to terminal hosts and has higher
specificity than xterm.js's built-in scrollbar rules. The scrollbar continues
to become visible/invisible through its existing opacity values, but the
transition is instantaneous, so terminal output no longer schedules an
800ms compositor animation.

## Testing and acceptance

- A stylesheet contract test fails before the override and passes after it,
  asserting both xterm scrollbar selectors share `transition: none`.
- A Playwright check on a live terminal confirms the computed transition on
  both visible and fade scrollbar elements is `none`.
- Existing frontend unit tests, typecheck, production build, and focused
  terminal Playwright reliability tests remain green.
- The final report includes a fresh trace/event comparison where available;
  source-level success must not be presented as proof that WindowServer CPU or
  GPU usage is zero, because that metric is external to the browser trace.

## Non-goals

- Do not remove WebGL or change xterm renderer selection.
- Do not change output batching, PTY protocol, terminal history, resize
  claims, pane virtualization, or visual layout.
- Do not add a permanent animation, polling loop, or browser timer.
