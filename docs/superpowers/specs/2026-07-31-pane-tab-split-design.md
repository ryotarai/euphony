# Pane Tab Split Design

## Goal

Let a user Command-click a pane source icon to show that source beside the
currently selected source. Keep normal tab clicks as single-source navigation
and let the user drag the divider to choose how much width each source gets.

## Interaction

- A normal click selects one source and closes any source split.
- Command-clicking an inactive source opens it on the right without changing
  the selected source on the left.
- Command-clicking the right-hand source again closes the split.
- Command-clicking the selected left-hand source closes an existing split and
  otherwise does nothing.
- Command-clicking another inactive source replaces the right-hand source.
- The divider starts at 50%, is draggable from 20% through 80%, and supports
  Arrow, Home, and End keys.
- The selected tab keeps the existing underline. The split tab gets a quieter
  secondary underline so both visible sources are legible without inventing a
  new toolbar.

## Layout and Lifecycle

Each source is mounted once in a shared stage. In single-source mode only the
selected panel is visible. In split mode CSS grid assigns the selected source
to the left track and the secondary source to the right track, separated by a
flush one-pixel divider with a wider pointer target.

The Terminal source reports capacity whenever it is visible on either side of
a split. Opening a split beside Terminal shrinks the PTY to the terminal
track's measured width, dragging the divider continuously follows that width,
and closing the split restores the full-width claim. This keeps PTY wrapping
aligned with the visible xterm canvas instead of clipping full-width rows.

Switching to a single non-terminal source still retains the last accepted
terminal claim. A split containing no visible Terminal source also retains that
claim. Split visibility must remain independent from pane activity so opening a
secondary source does not focus the terminal.

Agent log, Git changes, and Files views are active whenever they are visible in
either side of the split. Annotation removal closes or repairs a split before
falling back to Terminal.

## Verification

Component tests cover normal versus Command-click behavior, split replacement
and closing, terminal visibility and focus signals, divider dragging, divider
keyboard controls, and annotation cleanup. Existing pane and terminal tests
guard hidden-source capacity retention. Type checking, the frontend suite, a
production build, and a Playwright scenario verify that the reported terminal
columns shrink, follow the divider, and return to full width.
