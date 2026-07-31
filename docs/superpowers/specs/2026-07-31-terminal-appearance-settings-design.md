# Terminal Appearance Settings Design

## Goal

Let people tune terminal readability and interaction without changing the
existing Euphony appearance for current installations. The requested line
height control is the primary feature; the additional controls are limited to
xterm options that are already part of the terminal's behavior.

## User Experience

The Settings dialog adds a **Terminal appearance** section alongside the
existing font, history, shortcut, and attention settings:

| Setting | Control | Range or choices | Default |
| --- | --- | --- | --- |
| Terminal line height | Numeric input | 1.00–2.00, in 0.05 increments | 1.25 |
| Cursor style | Select | Bar, block, underline | Bar |
| Cursor blink | Checkbox | On or off | Off |
| Scroll sensitivity | Numeric input | 1–5, whole numbers | 3 |

The labels describe user-visible behavior rather than xterm implementation
details. Line height uses a unitless multiplier, and scroll sensitivity is
described as the amount of movement produced by a wheel gesture.

While Settings is open, valid draft values preview immediately in every
terminal pane. Saving persists the complete settings record. Cancel, Escape,
or dismissing the dialog discards drafts and restores the last saved terminal
behavior. Existing terminal history, font size, and font family controls keep
their current behavior.

## Architecture

`session.Settings` remains the source of truth. It gains four JSON fields:

- `terminalLineHeight` as a `float64` value backed by SQLite `REAL`
- `terminalCursorStyle` as one of `bar`, `block`, or `underline`
- `terminalCursorBlink` as a boolean
- `terminalScrollSensitivity` as an integer

New SQLite schemas include the four columns with defaults that match the
current hard-coded xterm options. Existing databases receive the columns
through additive `hasColumn` migrations, so opening an existing database does
not change its visible terminal behavior.

The settings API validates every new field and rejects malformed or out-of-
range payloads through the existing `invalid_settings` response. React keeps
saved settings and dialog drafts separate. A valid draft is folded into
`previewSettings` while the dialog is open, then routed through the existing
`renderTerminal` callback to `TerminalView`.

`TerminalView` passes all four values to the xterm constructor. Appearance
changes recreate the xterm instance using the existing history replay,
connection, and resize flow; changing history capacity continues to update
scrollback in place. This avoids adding a second update protocol to the
terminal driver and guarantees that line-height changes are measured before
the shared terminal grid is negotiated.

## Validation and Error Handling

- Line height must be finite, between 1.00 and 2.00 inclusive, and land on a
  0.05 increment.
- Cursor style must be exactly `bar`, `block`, or `underline`.
- Cursor blink must be present as a boolean.
- Scroll sensitivity must be a whole number from 1 through 5 inclusive.
- Client validation keeps the dialog open and associates a clear message with
  the first invalid control.
- Server validation rejects missing, malformed, or out-of-range values.
- A failed save restores the previous saved settings through the existing
  optimistic-update path and reports the existing request error.

## Visual Direction

Preserve Euphony's dense black terminal-workspace identity and the existing
compact Settings field language. The new controls use the same labels,
border, spacing, and responsive behavior as the font-size group. Numeric
controls show their meaningful units or scale rather than introducing new
decoration. The live terminal preview is the feedback mechanism and the only
visual emphasis needed.

## Alternatives Considered

- Adding only line height would minimize code, but would leave the cursor and
  scrolling behavior fixed even though they directly affect terminal comfort.
- A broad appearance editor with themes, selection behavior, and keybindings
  would offer more flexibility but would expand the settings model and
  validation surface beyond this request.
- The selected focused group adds only existing xterm options, preserves all
  current defaults, and keeps the Settings dialog understandable.

## Testing

- SQLite tests prove new defaults, round-trip persistence, and migration from
  a legacy settings table without the four columns.
- Settings API tests prove accepted values, trimming/normalization where
  applicable, and rejection of invalid line heights, cursor styles, booleans,
  and scroll sensitivities.
- Terminal tests prove all four values reach the terminal factory and that an
  appearance change recreates the driver while a history-only change does not.
- React tests prove controls render, preview, save, and discard drafts, and
  that saved values reach terminal panes.
- Playwright verifies persistence across reload, applied xterm appearance,
  and the Settings dialog at desktop and mobile widths.
