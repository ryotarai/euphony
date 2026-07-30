# Pane Navigation Design

## Summary

Give every selected terminal pane a practical minimum width. When the workspace
cannot show every pane at that width, keep all terminals mounted in a clipped
horizontal rail and show directional controls at the available edges. Each
press moves the visible window by exactly one pane.

## Interaction

- A pane requires at least `360px`.
- The viewport shows the largest whole number of panes that fit.
- The right control appears whenever another pane exists beyond the right edge.
- After moving right, the left control appears; the controls disappear at their
  respective ends.
- Adding, selecting, or keyboard-focusing an off-screen pane moves the window
  just enough to reveal it.
- Resizing recomputes capacity, clamps the current window, and removes controls
  when every pane fits.
- Off-screen panes remain mounted so terminal sockets, history, and pane-local
  tabs are preserved. They are hidden from pointer and accessibility navigation.

## Component Boundary

Create `PaneCarousel`, responsible only for measuring its viewport, deriving
the visible range, rendering pane chrome, and moving that range. `App` remains
responsible for selection, focus, URL state, connection state, and terminal
content.

The visible pane count is derived as:

```text
max(1, min(pane count, floor(viewport width / 360px)))
```

Before a real width is available, one pane is shown. A `ResizeObserver`
supplies subsequent widths. The rail uses equal-width CSS grid tracks, each
`viewport width / visible count`, and translates by one track per offset.

## Visual Direction

This is a local terminal control surface for developers supervising parallel
agents. The controls should feel like hardware transport controls attached to
the viewport edge, not a new toolbar.

Palette and type inherit the existing workspace:

- Signal black `#050505`
- Raised black `#0B0D0F`
- Hairline `#262626`
- Paper white `#F5F5F5`
- Instrument gray `#8A8A8A`
- Existing Geist UI face and terminal monospace stack

The signature element is a compact square arrow that straddles the clipped
edge, with a quiet translucent black surface and a precise gray border. Motion
is limited to the single rail translation and is removed when reduced motion
is requested.

## Accessibility

Controls are native buttons with `Show previous pane` and `Show next pane`
labels. Off-screen panes receive `aria-hidden`, `visibility: hidden`, and no
pointer events. Keyboard focus keeps its existing tmux-style behavior, and
focus changes reveal the target pane.

## Verification

- Vitest covers capacity calculation, edge control visibility, one-pane
  movement, focus reveal, and resize clamping.
- Existing App and terminal tests guard URL, focus, and mount behavior.
- Playwright verifies real widths, arrow movement, minimum pane width, and the
  mobile one-pane case against an isolated in-memory server.

