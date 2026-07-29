# Prefix Command Guide Design

## Goal

Make tmux-style prefix mode explicit and unhurried. After the configured prefix is pressed, Euphony waits indefinitely for one command key, shows the available commands, and exits prefix mode only after a command, an unsupported key, or Escape.

## Interaction

- The configured prefix enters prefix mode and is not sent to the terminal.
- Prefix mode has no timeout.
- `Escape` cancels prefix mode and is not sent to the terminal.
- `c`, `v`, `h`, `l`, `n`, and `p` run their existing commands and leave prefix mode.
- Any other key leaves prefix mode and continues through to the terminal.
- Session polling, pane updates, and keybinding listener rebuilds do not clear prefix mode.

## Presentation

Render one fixed command legend at the bottom of the viewport while prefix mode is active:

`c: Create a terminal | v: Split vertically | h/l: Focus pane | n/p: Switch terminal | Esc: Cancel`

The legend uses Euphony's existing terminal palette and monospace utility type. It sits above terminal content as a compact tmux-like status line rather than resizing panes. On narrow screens it remains a single line and scrolls horizontally.

## State and Accessibility

Prefix mode becomes React state because the UI must render it. The legend uses `role="status"` with a stable accessible label. It has no focusable controls; its narrow-screen overflow remains touch-scrollable.

## Verification

- Unit tests prove the legend remains after more than 1.5 seconds.
- Unit tests prove Escape dismisses it without reaching the focused terminal.
- Existing keybinding tests prove commands still work.
- Playwright verifies the legend and Escape behavior while xterm owns focus.

## Sidebar Selection Addendum

- Each terminal row has a checkbox on its left. Checking it adds that terminal to the current pane selection; unchecking removes it while preserving the existing at-least-one-pane rule.
- Clicking the terminal row itself keeps the existing exclusive-selection behavior.
- Clicking status text replaces the current pane selection with every terminal in that status.
- Status checkboxes retain their existing additive monitoring behavior.
