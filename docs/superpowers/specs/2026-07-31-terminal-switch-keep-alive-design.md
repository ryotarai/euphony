# Terminal Switch Keep-Alive Design

## Goal

Keep a browser terminal's xterm instance and terminal WebSocket alive after the
terminal is deselected, so selecting it again does not replay the server's
history snapshot as visible startup output.

## Design

The application will track terminal IDs that have been selected at least once
while the corresponding session still exists. `PaneCarousel` will render both
the currently selected panes and these cached panes under one stable keyed
parent. Cached panes receive the native `hidden` attribute, so their terminal
DOM and React effects remain mounted while they are removed from layout and
accessibility navigation.

The selected pane list remains the source of carousel layout, focus, and
selection semantics. Cached panes do not count toward the visible pane width or
carousel offset. When a cached ID becomes selected, only its `hidden` state and
active state change; the `TerminalPane` and `TerminalView` instances remain
the same. Deleted sessions are removed from the cache on the next session
snapshot.

Hidden terminal hosts already release their active PTY size claim through the
existing visibility check. Live output still reaches the mounted xterm while
hidden, so returning to a terminal shows the current screen without a fresh
history stream.

## Failure Handling

If a cached terminal's WebSocket disconnects, it keeps the existing disconnected
state and can still be reconnected using the existing action. Cache retention
does not change PTY process lifetime or server history limits. If a session is
deleted, React unmounts its cached pane and the existing terminal cleanup closes
its browser resources.

## Verification

- Pane carousel tests cover cached panes not affecting visible count or offset.
- App tests cover selecting terminal A, selecting terminal B, and returning to
  A without unmounting A's terminal view.
- Existing frontend unit tests, type checking, Go tests, and Playwright checks
  remain green.
