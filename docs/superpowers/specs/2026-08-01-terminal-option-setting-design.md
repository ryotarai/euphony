# Terminal Option-as-Alt Setting

## Goal

Allow users to turn the terminal's macOS Option-as-Alt behavior off from
Settings while preserving the current enabled-by-default behavior.

## Design

Add a persisted boolean setting named `terminalOptionAsAlt`. Its default is
`true`, so existing installations keep the behavior introduced by
`macOptionIsMeta: true`. The SQLite settings table receives a migration with a
default of `1`; the settings API reads, validates, persists, and returns the
field.

The Settings dialog adds an `Option as Alt` checkbox inside the existing
Terminal appearance section. Its description explains that macOS Option keys
are sent as Alt sequences to terminal applications. The checkbox participates
in the existing draft/preview flow: changing it updates mounted terminal
instances immediately, Save persists it, and Cancel restores the saved value.

The App passes the setting to TerminalView. TerminalView passes it to the
xterm options helper as `macOptionIsMeta`, recreating the xterm instance when
the setting changes because the option is supplied during construction.

## Testing

- Go tests cover the default, SQLite round-trip, API round-trip, and invalid
  request handling.
- React tests cover Settings draft preview/cancel/save behavior and the
  TerminalView option mapping for both enabled and disabled values.
- Run the complete Web unit suite, Go tests relevant to settings, typecheck,
  build, and the existing Playwright suite when the local server harness is
  available.

## Scope

No new settings page, per-terminal override, platform detection, or backend
PTY protocol change is needed.
