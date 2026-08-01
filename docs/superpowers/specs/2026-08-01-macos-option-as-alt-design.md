# macOS Option as Alt in Terminal

## Goal

Make Option-modified keystrokes in Euphony's terminal behave like Alt-modified
keystrokes, matching Ghostty's `macos-option-as-alt = true` behavior.

## Design

The terminal uses xterm.js, which already provides the cross-platform
`macOptionIsMeta` option. Set it to `true` when constructing the xterm instance.
With this option enabled, xterm.js emits Option-modified keys with an ESC
prefix instead of treating macOS Option as a third-level character modifier.
The existing PTY/WebSocket input path therefore receives the same Alt sequence
used by terminal applications without any backend changes.

Keep the setting unconditional at terminal construction time. xterm.js only
uses the macOS-specific behavior on macOS, while its existing non-macOS Alt
handling remains compatible.

## Testing

Expose the terminal option construction as a small testable helper and add a
regression test asserting `macOptionIsMeta: true`. Run the focused Vitest test,
the web typecheck/build, and the repository's relevant Go tests if required by
the final verification workflow.

## Scope

No new user setting, UI control, backend protocol, PTY change, keybinding
change, or platform detection is needed.
