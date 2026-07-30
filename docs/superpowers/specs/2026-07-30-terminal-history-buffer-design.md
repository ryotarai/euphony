# Configurable Terminal History Buffer Design

## Goal

Let users configure how much raw terminal output Euphony retains for reconnects,
including an unlimited option, while expanding browser scrollback without
creating unsafe finite row capacities.

## Approaches Considered

1. Configure only xterm.js scrollback rows. This changes how far the current
   browser can scroll, but reconnects still replay at most the server's fixed
   1 MiB history.
2. Configure only the server byte buffer. This improves reconnect replay, but
   xterm.js can still discard older rows.
3. Use one coordinated setting with layer-specific units. The server enforces
   the exact byte setting, while the browser derives a bounded finite row
   capacity because xterm.js scrollback is measured in rendered rows. This is
   the selected approach.

## Settings Contract

Add `terminalHistoryLimit` to the settings JSON contract. It is an integer
number of bytes. `0` means unlimited. The default remains `1048576` bytes
(1 MiB), preserving the current server behavior.

The settings dialog presents the finite value in whole MiB and provides an
`Unlimited` checkbox. Finite values range from 1 through 4095 MiB.

The API requires the field, rejects fractional, negative, below-minimum,
above-maximum, and non-whole-MiB finite values, and persists it in SQLite.
Existing databases gain the column with the 1 MiB default.

## Server History

Each running `Session` owns its current history limit. New and restored
sessions receive the manager's current setting at the same locked registration
point that makes them visible to settings updates. Publishing output stores
immutable chunks of at most 32 KiB and trims whole chunks, or only the leading
partial chunk, when the limit is nonzero. Snapshots copy only chunk references.

Updating settings applies the new limit to every running session after the
settings save succeeds. Lowering a limit immediately retains only the newest
bytes. Raising the limit cannot restore already discarded output; it affects
future output. Switching to unlimited stops further trimming. Reconnect replay
sends one bounded WebSocket message per history chunk followed by
`history_end`, avoiding a second full-history allocation and a single
multi-gigabyte JSON frame.

## Browser Scrollback

`App` passes `terminalHistoryLimit` to every `TerminalView`. Because xterm.js
measures scrollback in rendered rows rather than bytes, finite limits derive a
browser-safe row capacity using one row per 128 retained bytes, clamped to
1,000–100,000 rows. Unlimited maps to xterm.js's maximum `4294967295` and is
explicitly presented as a memory-risk choice.

When the setting changes, the mounted terminal updates its scrollback option
without reconnecting or replacing the terminal. Reducing it lets xterm.js trim
old rows immediately; increasing it preserves current rows and expands future
capacity. Chunked replay keeps terminal-generated replies suppressed until
`history_end` has arrived and every queued history write has completed.

## Settings UI

The existing Settings dialog gains one `History buffer` field:

- a numeric input with a `MiB` suffix;
- an `Unlimited` checkbox that disables the numeric input while checked;
- helper text explaining that the value controls retained reconnect output and
  that large or unlimited history can increase memory use;
- inline validation for values outside 1–4095 MiB.

Opening or canceling the dialog resets drafts from saved settings. Saving
normalizes the MiB value to bytes and sends it with the existing settings.

## Error Handling

Client validation keeps the dialog open and associates an accessible error with
the history field. Server validation remains authoritative and returns the
existing `invalid_settings` response for malformed settings. Failed saves roll
back the optimistic settings state through the existing persistence path.

## Verification

- Go unit tests cover chunked finite trimming, unlimited retention, atomic
  session registration, immediate trimming after a live settings update, API
  validation, persistence, and legacy schema migration.
- React unit tests cover loading, editing, saving, unlimited mode, validation,
  and forwarding the setting to terminal panes.
- TerminalView tests cover safe conversion to xterm.js scrollback, live option
  updates, and multi-frame replay completion.
- Playwright verifies that the Settings dialog exposes, persists, and restores
  both finite and unlimited values.
