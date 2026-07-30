# Terminal Font Family Setting Design

## Goal

Let people choose the font family used by every Euphony terminal while
preserving the current font stack for existing installations.

## User Experience

The Settings dialog gains a **Terminal font** text field beneath the existing
font-size controls. The field accepts a CSS font-family value, including a
comma-separated fallback stack such as:

`JetBrains Mono, Menlo, monospace`

Changes preview immediately while the dialog is open. **Save settings**
persists the value with the other workspace settings. **Cancel**, Escape, or
dismissing the dialog restores the last saved font.

The default remains:

`Menlo, Monaco, "Hiragino Sans", "Yu Gothic", "Noto Sans Mono CJK JP", monospace`

## Architecture

`session.Settings` remains the source of truth. It gains a
`TerminalFontFamily` string serialized as `terminalFontFamily`. SQLite stores
the value in a new `terminal_font_family` column whose default preserves the
existing xterm font stack. Legacy databases receive the column through the
existing additive migration flow.

The settings API accepts a trimmed, non-empty font-family string of at most 256
Unicode code points. The React app keeps a draft separate from the saved
settings. While Settings is open, the valid trimmed draft is routed to each
terminal; otherwise the saved value is used. `TerminalView` passes the value to
xterm's `fontFamily` option and recreates the terminal when it changes, reusing
the existing resize and history replay behavior.

## Alternatives Considered

- A fixed dropdown is simpler but excludes fonts installed by the user and
  cannot represent fallback stacks.
- Browser font enumeration would improve discoverability, but the Font Access
  API has permission and browser-support costs that are disproportionate to
  this setting.
- A free-form CSS font-family field is portable, supports arbitrary installed
  fonts, and matches xterm's native configuration model. This is the selected
  approach.

## Visual Direction

Preserve Euphony's dense black terminal-workspace identity and existing
Settings field language. The control is a full-width field because font stacks
are longer than the compact numeric size controls. Its description explains
that unavailable fonts fall through to the next family. No new color,
decoration, or motion is introduced; the live terminal preview is the
distinctive feedback.

## Validation and Errors

- Trim leading and trailing whitespace before previewing and saving.
- Reject empty values and values longer than 256 Unicode code points.
- Keep the dialog open and associate a clear validation message with the field.
- Reject missing, empty, or overlong API values with the existing
  `invalid_settings` response.
- A failed save restores the previously saved settings through the existing
  optimistic-update path and reports the existing request error.

## Testing

- SQLite tests prove the default, round-trip persistence, and legacy migration.
- Settings API tests prove accepted, trimmed, missing, empty, and overlong
  values.
- React tests prove the field is rendered, previewed, saved, and canceled.
- Terminal tests prove the configured family reaches the terminal driver and a
  family change recreates the xterm instance.
- Playwright verifies persistence across reload and the applied terminal font
  style through the live xterm helper element.
