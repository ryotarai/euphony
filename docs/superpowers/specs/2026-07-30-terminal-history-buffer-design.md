# Configurable Terminal History Buffer Design

## Goal

Let users configure how much terminal output Euphony retains, including an
unlimited option, without leaving a smaller hidden limit in either the server
or browser terminal.

## Approaches Considered

1. Configure only xterm.js scrollback rows. This changes how far the current
   browser can scroll, but reconnects still replay at most the server's fixed
   1 MiB history.
2. Configure only the server byte buffer. This improves reconnect replay, but
   xterm.js can still discard older rows.
3. Use one coordinated setting for both layers. This keeps reconnect replay
   and visible scrollback aligned and is the selected approach.

## Settings Contract

Add `terminalHistoryLimit` to the settings JSON contract. It is an integer
number of bytes. `0` means unlimited. The default remains `1048576` bytes
(1 MiB), preserving the current server behavior.

The settings dialog presents the finite value in whole MiB and provides an
`Unlimited` checkbox. Finite values range from 1 through 4095 MiB. The maximum
keeps the corresponding xterm.js row capacity below its `2^32 - 1` limit.

The API requires the field, rejects fractional, negative, below-minimum, and
above-maximum finite values, and persists it in SQLite. Existing databases gain
the column with the 1 MiB default.

## Server History

Each running `Session` owns its current history limit. New and restored
sessions receive the manager's current setting. Publishing output trims the
raw byte history only when the limit is nonzero.

Updating settings applies the new limit to every running session after the
settings save succeeds. Lowering a limit immediately retains only the newest
bytes. Raising the limit cannot restore already discarded output; it affects
future output. Switching to unlimited stops further trimming.

## Browser Scrollback

`App` passes `terminalHistoryLimit` to every `TerminalView`. The xterm.js
scrollback capacity is set to the finite byte count, which is a conservative
row capacity large enough for the retained raw stream, or to xterm.js's maximum
`4294967295` for unlimited.

When the setting changes, the mounted terminal updates its scrollback option
without reconnecting or replacing the terminal. Reducing it lets xterm.js trim
old rows immediately; increasing it preserves current rows and expands future
capacity.

## Settings UI

The existing Settings dialog gains one `History buffer` field:

- a numeric input with a `MiB` suffix;
- an `Unlimited` checkbox that disables the numeric input while checked;
- helper text explaining that the value controls retained terminal output and
  that unlimited history can increase memory use;
- inline validation for values outside 1–4095 MiB.

Opening or canceling the dialog resets drafts from saved settings. Saving
normalizes the MiB value to bytes and sends it with the existing settings.

## Error Handling

Client validation keeps the dialog open and associates an accessible error with
the history field. Server validation remains authoritative and returns the
existing `invalid_settings` response for malformed settings. Failed saves roll
back the optimistic settings state through the existing persistence path.

## Verification

- Go unit tests cover finite trimming, unlimited retention, immediate trimming
  after a live settings update, API validation, persistence, and legacy schema
  migration.
- React unit tests cover loading, editing, saving, unlimited mode, validation,
  and forwarding the setting to terminal panes.
- TerminalView tests cover conversion to xterm.js scrollback and live option
  updates.
- Playwright verifies that the Settings dialog exposes, persists, and restores
  both finite and unlimited values.

