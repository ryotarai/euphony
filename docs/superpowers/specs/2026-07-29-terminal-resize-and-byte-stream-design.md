# Terminal Resize and Byte Stream Reliability Design

## Context

An existing Claude Code terminal can occasionally retain an invalid width after
the workspace changes from one pane to two panes. The same terminal path can
also display Unicode replacement characters when Japanese output crosses PTY
read boundaries.

The current frontend relies on `ResizeObserver` alone after the terminal is
mounted. It also records a terminal size as deduplicated even when no open
WebSocket exists to deliver that size. The server converts each PTY `[]byte`
chunk to a JSON string independently, so `encoding/json` replaces incomplete
UTF-8 fragments with U+FFFD.

## Design

### Pane topology resize

`App` will pass the current pane count to every `TerminalView` as a layout
version. When that value changes, `TerminalView` will perform a trailing fit
after the grid has committed its final dimensions. This supplements the
`ResizeObserver` instead of replacing it.

Resize deduplication will represent sizes successfully sent to an open socket,
not sizes merely observed locally. The WebSocket open handler will force one
resize with the terminal's current columns and rows after fitting.

This follows the working Oriel pattern of sending dimensions on connection and
performing an explicit delayed fit after split layout changes.

### Lossless PTY payloads

History and live output messages will carry PTY bytes as base64 in the existing
JSON `data` field. Go's `encoding/json` natively serializes `[]byte` as base64.
The frontend will decode that field into `Uint8Array` and pass the bytes
directly to xterm.

Exit and error messages remain normal JSON strings. Client input remains a JSON
string because xterm input arrives as a valid JavaScript string and Go writes
its UTF-8 bytes unchanged.

## Error Handling

Malformed base64 output will be ignored rather than written as corrupt terminal
content. Existing WebSocket disconnection behavior remains unchanged.

## Testing

- A frontend unit test will prove that a resize observed before socket open is
  still delivered after open.
- A frontend unit test will prove that a pane topology change triggers a
  trailing fit even if `ResizeObserver` misses the transition.
- A frontend unit test will prove that base64 terminal output reaches xterm as
  the original bytes.
- A server integration test will emit a Japanese character across separate PTY
  writes and prove the WebSocket payload reconstructs the original bytes.
- Playwright will repeatedly switch a running Claude Code session between one
  and two panes while asserting that no implausibly narrow resize is sent.

## Visual Design

No colors, typography, spacing, or interaction affordances change. The existing
terminal workspace appearance remains intact.
