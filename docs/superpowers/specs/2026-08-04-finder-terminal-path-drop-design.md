# Finder Terminal Path Drop Design

## Goal

Let users drag files or folders from Finder onto an Euphony terminal and insert
their absolute paths into the current shell input.

## Behavior

- The macOS wrapper handles only drops containing one or more local file URLs.
- Each URL is resolved to an absolute POSIX path before it crosses into the
  web view.
- Paths are quoted for POSIX shells with single quotes. Embedded single quotes
  use the standard `'\''` sequence.
- Multiple paths are joined with one space, preserving their dropped order.
- The text is sent through the terminal's existing input WebSocket message.
- Dropping does not append Enter, so the user can edit or cancel the command.
- The terminal receives focus after a successful drop.
- HTTP URLs, arbitrary text, malformed file URLs, and non-local file hosts are
  ignored so normal browser drag behavior is not mistaken for shell input.
- No setting, dependency, toast, or persistent visual state is added.

## Approaches considered

1. **Bridge drops through the macOS `WKWebView` wrapper (recommended).**
   WebKit intentionally suppresses Finder `file://` values from web
   `DataTransfer`, so the native pasteboard is the reliable path source. The
   wrapper hit-tests the drop point to preserve the target pane.
2. **Parse browser drag data in `TerminalView`.** This is useful for synthetic
   URI-list drags, but WebKit's local-path privacy filtering prevents it from
   satisfying Finder drops by itself.
3. **Support both paths immediately.** This adds a fallback before evidence
   shows one is needed and creates two event contracts to maintain.

## Components and data flow

`FileDropBridge.swift` will read local URLs from the native pasteboard,
JSON-encode their paths, convert the AppKit drop coordinate to a browser client
coordinate, and dispatch `euphony-file-drop` to the `.terminal-host` beneath
that point.

`terminalDrop.ts` will own POSIX quoting as a pure function.
`TerminalView` will listen for the bridge event on its host, validate the path
array, send one `{ type: "input", data }` message through the current socket,
and focus xterm. A URI-list listener remains as a browser-compatible
best-effort path when a non-WebKit source exposes local URLs.

## Testing

- Unit tests will cover spaces, percent-encoding, embedded quotes, multiple
  paths, comments, non-local hosts, malformed values, and non-file URLs.
- A component test will prove that a real drop on one terminal host produces
  one input message without Enter and restores terminal focus.
- A Swift bridge test will prove that paths are JSON encoded and dispatched to
  the terminal beneath the drop point.
- Frontend tests, typecheck, build, and the complete Go test suite will pass.
