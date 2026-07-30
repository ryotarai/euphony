# Pane Tab Shortcut and Markdown Table Design

## Goal

Let the user toggle the focused terminal pane between its terminal and agent-log
tabs with `Meta+L` by default, make that shortcut configurable in Settings, and
make Markdown tables in agent logs readable.

## Interaction

- `Meta+L` toggles the focused pane between `terminal` and `agent-log`.
- Only the focused pane responds when multiple panes are visible.
- The shortcut is ignored while a regular form control or editable region has
  focus. The xterm input remains eligible so the shortcut works during terminal
  use.
- The pane keeps its existing local tab state; the shortcut invokes the same
  source-change path as clicking the tab icons.
- Settings exposes a `Pane tab toggle` shortcut field next to the existing
  prefix field. Both values use the existing normalized modifier-plus-key
  syntax, such as `Meta+L` or `Ctrl+J`.
- Invalid shortcuts keep the dialog open and display an accessible field error.

## Persistence

Add `paneTabShortcut` to the shared Settings model:

- Frontend default: `Meta+L`
- Server/session default: `Meta+L`
- SQLite column: `pane_tab_shortcut TEXT NOT NULL DEFAULT 'Meta+L'`
- Existing databases receive the column through an additive migration.
- Settings API validates the value with the same modifier-plus-key grammar as
  the prefix.

## Markdown Tables

Keep the existing dark, compact log surface. Markdown tables use:

- collapsed one-pixel neutral borders around every cell;
- `0.5rem 0.65rem` cell padding;
- left-aligned, slightly brighter headers on a restrained dark background;
- full available width with horizontal overflow contained by the Markdown
  surface.

No new color accent or card treatment is introduced. The table should read as a
data instrument inside the transcript, not as a separate dashboard widget.

## Accessibility and Error Handling

- Shortcut input labels are programmatically associated with their inputs.
- Invalid fields set `aria-invalid` and render an accessible error message.
- Keyboard handling calls `preventDefault` and stops propagation only when the
  configured shortcut matches the focused pane.
- Existing click-based tab switching remains unchanged.

## Verification

- Go tests cover defaults, persistence, migration, API acceptance, and invalid
  shortcut rejection.
- Component tests cover default/custom shortcut toggling, inactive pane
  isolation, and editable-field suppression.
- App tests cover Settings loading and saving both shortcuts.
- Playwright covers `Meta+L`, a saved custom shortcut, and computed table cell
  border/padding in Chromium.

