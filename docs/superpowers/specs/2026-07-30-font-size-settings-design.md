# Font Size Settings Design

## Goal

Let people tune Euphony's interface, terminal, and agent-log text independently
without changing the current appearance for existing installations.

## User Experience

The Settings dialog gains an **Font sizes** group with three numeric pixel
controls:

- Interface: 16 px by default
- Terminal: 14 px by default
- Agent log: 14 px by default

Each value accepts an integer from 10 through 24. Changes preview immediately
while the dialog is open. **Save settings** persists all three values together
with the existing shortcuts. **Cancel**, Escape, or dismissing the dialog
restores the last saved values.

The interface size scales the application chrome and sidebar. Terminal size is
passed to xterm and causes the terminal to be recreated and fitted. Agent-log
size scales transcript prose, code, tables, headings, and metadata
proportionally through CSS custom properties.

## Architecture

`session.Settings` remains the source of truth. SQLite stores three new integer
columns with defaults so old databases migrate without a visible change. The
settings API validates every size independently and rejects non-integers and
values outside 10–24.

React keeps saved settings and dialog drafts separately. The workspace receives
an interface font-size custom property; terminal and agent-log components
receive their respective numeric sizes as props. Draft values are used only
while the Settings dialog is open, so canceling reliably rolls back the preview.

## Visual Direction

Preserve Euphony's dense black terminal-workspace identity. Font-size controls
use the existing field language and a compact three-column row on desktop,
stacking on narrow screens. Pixel suffixes and explicit labels make the units
unambiguous. No new color or decorative treatment is introduced; typography is
the subject of the control.

## Validation and Errors

- Valid values are integers in the inclusive range 10–24.
- Client validation keeps the dialog open and associates a clear message with
  the first invalid field.
- Server validation rejects malformed payloads and returns the existing
  `invalid_settings` response.
- A failed save restores the previously saved settings through the existing
  optimistic-update path and reports the existing request error.

## Testing

- SQLite tests prove defaults, round-trip persistence, and legacy migration.
- Settings API tests prove accepted values and boundary/type rejection.
- React tests prove the settings are rendered, previewed, saved, and canceled.
- Terminal tests prove the configured size reaches the terminal driver and a
  size change recreates the xterm instance.
- Agent-log tests prove the configured CSS variable is applied.
- Playwright verifies persistence across reload and captures the dialog at
  desktop and mobile widths.

