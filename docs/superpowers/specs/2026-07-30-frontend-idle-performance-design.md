# Frontend Idle Performance Design

## Goal

Reduce steady-state frontend work while a terminal remains open without
changing terminal connectivity, live output, session polling frequency, or
workspace behavior.

## Scope

- Render a visible, non-animated bar cursor in xterm.
- Preserve the existing 1,500 ms session polling interval.
- Ignore polling responses whose ordered session metadata is shallowly equal
  to the current React state.
- Continue processing attention and agent-launch transitions on every polling
  response before deciding whether React state needs an update.

The design does not change the Go server, terminal history, WebSocket
protocol, output batching, agent-log polling, or multi-pane lifecycle.

## Architecture

`TerminalView` continues to own xterm construction. Its default terminal
options disable `cursorBlink` while retaining the existing bar cursor and
colors. This removes xterm's infinite CSS cursor animation while leaving the
cursor visible.

`App` gains a small ordered shallow-equality helper for `Session[]`. Every
`Session` field is a primitive, so comparing enumerable own keys is sufficient
and automatically accounts for newly added serialized fields. The polling
callback still computes transitions and refreshes `previousSessionsRef`, then
uses a functional `setSessions` update that returns the existing array when the
response is equal. React can therefore bail out without rendering the app,
sidebar, or terminal panes.

## Data Flow

1. `ApiClient.listSessions()` returns the next ordered session array.
2. `App` compares the response with the previous metadata for transition
   detection.
3. Attention notifications and focused-terminal promotion remain unchanged.
4. `previousSessionsRef` receives the response.
5. `setSessions` keeps the current state reference when metadata and ordering
   are unchanged; otherwise it stores the new response.

## Error Handling

Polling errors remain intentionally ignored, matching current reconnect
behavior. Equality comparison treats different array lengths, ordering,
enumerable keys, or primitive values as changes.

## Testing

- A `TerminalView` browser test verifies the real xterm cursor has no blinking
  class while remaining present.
- An `App` integration test advances the 1,500 ms polling interval with an
  equal response and verifies the selected terminal subtree does not render
  again.
- Existing polling tests continue to verify that changed metadata, removed
  terminals, filters, attention, and agent launches still update the UI.
- Run the complete Go, Vitest, TypeScript, build, and focused Playwright
  verification before merging.
